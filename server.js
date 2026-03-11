const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const archiver = require('archiver');
archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
const nodemailer = require('nodemailer');

const app = express();
const PORT = 3000;

// ディレクトリパス
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');

// ディレクトリがなければ作成
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// JSON パース
app.use(express.json());

// 静的ファイル配信
app.use(express.static(path.join(__dirname, 'public')));

// ファイルアップロード設定
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // 日本語ファイル名対応
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e4);
    const ext = path.extname(originalName);
    const base = path.basename(originalName, ext);
    cb(null, `${base}_${uniqueSuffix}${ext}`);
  }
});
const upload = multer({ storage });

// セッション内のアップロードファイルを管理（簡易的にメモリ管理）
const sessions = new Map();

// パスワード生成（12桁英数字記号）
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// セッションID生成
function generateSessionId() {
  return crypto.randomBytes(16).toString('hex');
}

// ファイルアップロード
app.post('/api/upload', upload.array('files'), (req, res) => {
  const sessionId = req.headers['x-session-id'] || generateSessionId();

  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { files: [], createdAt: Date.now() });
  }

  const session = sessions.get(sessionId);

  const uploadedFiles = req.files.map(f => {
    const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
    return {
      storedName: f.filename,
      originalName: originalName,
      size: f.size,
      path: f.path
    };
  });

  session.files.push(...uploadedFiles);

  res.json({
    sessionId,
    files: session.files.map(f => ({
      name: f.originalName,
      size: f.size
    }))
  });
});

// アップロード済みファイル削除
app.delete('/api/upload/:index', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const index = parseInt(req.params.index, 10);

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: 'セッションが見つかりません' });
  }

  const session = sessions.get(sessionId);
  if (index < 0 || index >= session.files.length) {
    return res.status(400).json({ error: '無効なインデックス' });
  }

  const removed = session.files.splice(index, 1)[0];
  // 一時ファイル削除
  try { fs.unlinkSync(removed.path); } catch (e) { /* ignore */ }

  res.json({
    files: session.files.map(f => ({
      name: f.originalName,
      size: f.size
    }))
  });
});

// ZIPロック
app.post('/api/lock', async (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: 'ファイルがアップロードされていません' });
  }

  const session = sessions.get(sessionId);
  if (session.files.length === 0) {
    return res.status(400).json({ error: 'ファイルがありません' });
  }

  const password = generatePassword();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const zipFilename = `locked_${timestamp}.zip`;
  const zipPath = path.join(OUTPUT_DIR, zipFilename);

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver.create('zip-encrypted', {
        zlib: { level: 9 },
        encryptionMethod: 'zip20',  // ZipCrypto（Windows互換）
        password: password
      });

      output.on('close', resolve);
      archive.on('error', reject);

      archive.pipe(output);

      for (const file of session.files) {
        archive.file(file.path, { name: file.originalName });
      }

      archive.finalize();
    });

    // 一時ファイル削除
    for (const file of session.files) {
      try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
    }

    // セッション情報更新
    session.zipFilename = zipFilename;
    session.password = password;
    session.files = [];

    res.json({
      zipFilename,
      password,
      downloadUrl: `/api/download/${encodeURIComponent(zipFilename)}`
    });
  } catch (err) {
    console.error('ZIP作成エラー:', err);
    res.status(500).json({ error: 'ZIP作成に失敗しました: ' + err.message });
  }
});

// ZIPダウンロード
app.get('/api/download/:filename', (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'ファイルが見つかりません' });
  }

  res.download(filePath, filename);
});

// パスワードメール送信
app.post('/api/send-password', async (req, res) => {
  const { to, zipFilename, password, smtpHost, smtpPort, smtpUser, smtpPass, fromEmail } = req.body;

  if (!to || !password) {
    return res.status(400).json({ error: '宛先とパスワードは必須です' });
  }

  try {
    const transportConfig = {
      host: smtpHost || 'smtp.gmail.com',
      port: parseInt(smtpPort) || 587,
      secure: false,
      auth: {
        user: smtpUser || '',
        pass: smtpPass || ''
      }
    };

    const transporter = nodemailer.createTransport(transportConfig);

    const mailOptions = {
      from: fromEmail || smtpUser,
      to: to,
      subject: `【パスワード通知】${zipFilename || 'ファイル'}のパスワード`,
      text: `お世話になっております。\n\n先ほどお送りしたファイル（${zipFilename || '添付ファイル'}）のパスワードをお知らせいたします。\n\nパスワード: ${password}\n\nお手数ですが、上記パスワードにてファイルを解凍してください。\nご不明な点がございましたら、お気軽にお問い合わせください。\n\nよろしくお願いいたします。`
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'パスワードを送信しました' });
  } catch (err) {
    console.error('メール送信エラー:', err);
    res.status(500).json({ error: 'メール送信に失敗しました: ' + err.message });
  }
});

// 古いセッション・ファイルのクリーンアップ（1時間ごと）
setInterval(() => {
  const oneHour = 60 * 60 * 1000;
  const now = Date.now();

  for (const [id, session] of sessions) {
    if (now - session.createdAt > oneHour) {
      // 一時ファイル削除
      for (const file of session.files) {
        try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
      }
      sessions.delete(id);
    }
  }
}, 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`PDFロック サーバー起動: http://localhost:${PORT}`);
});
