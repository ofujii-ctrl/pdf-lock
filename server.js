const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
const nodemailer = require('nodemailer');
const { PassThrough } = require('stream');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// メモリストレージ（ディスク書き込み不要）
const upload = multer({ storage: multer.memoryStorage() });

// パスワード生成
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ZIP暗号化（メモリ内で完結）
function createEncryptedZip(files, password) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const passthrough = new PassThrough();

    passthrough.on('data', (chunk) => chunks.push(chunk));
    passthrough.on('end', () => resolve(Buffer.concat(chunks)));
    passthrough.on('error', reject);

    const archive = archiver.create('zip-encrypted', {
      zlib: { level: 9 },
      encryptionMethod: 'zip20',
      password: password
    });

    archive.on('error', reject);
    archive.pipe(passthrough);

    for (const file of files) {
      archive.append(file.buffer, { name: file.originalname });
    }

    archive.finalize();
  });
}

// ファイルアップロード → パスワード付きZIP生成（1リクエストで完結）
app.post('/api/lock', upload.array('files'), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'ファイルがアップロードされていません' });
    }

    const password = generatePassword();
    const zipBuffer = await createEncryptedZip(req.files, password);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipFilename = `locked_${timestamp}.zip`;

    res.json({
      password,
      zipFilename,
      zipBase64: zipBuffer.toString('base64'),
      fileCount: req.files.length
    });
  } catch (err) {
    console.error('ZIP作成エラー:', err);
    res.status(500).json({ error: 'ZIP作成に失敗しました: ' + err.message });
  }
});

// パスワードメール送信
app.post('/api/send-password', async (req, res) => {
  const { to, zipFilename, password, smtpHost, smtpPort, smtpUser, smtpPass, fromEmail } = req.body;

  if (!to || !password) {
    return res.status(400).json({ error: '宛先とパスワードは必須です' });
  }

  const host = smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(smtpPort || process.env.SMTP_PORT || '587');
  const user = smtpUser || process.env.SMTP_USER || '';
  const pass = smtpPass || process.env.SMTP_PASS || '';
  const from = fromEmail || process.env.SMTP_FROM || user;

  if (!user || !pass) {
    return res.status(400).json({ error: 'SMTP認証情報が設定されていません' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host, port, secure: false,
      auth: { user, pass }
    });

    await transporter.sendMail({
      from, to,
      subject: `【パスワード通知】${zipFilename || 'ファイル'}のパスワード`,
      text: `お世話になっております。\n\n先ほどお送りしたファイル（${zipFilename || '添付ファイル'}）のパスワードをお知らせいたします。\n\nパスワード: ${password}\n\nお手数ですが、上記パスワードにてファイルを解凍してください。\nご不明な点がございましたら、お気軽にお問い合わせください。\n\nよろしくお願いいたします。`
    });

    res.json({ message: 'パスワードを送信しました' });
  } catch (err) {
    console.error('メール送信エラー:', err);
    res.status(500).json({ error: 'メール送信に失敗しました: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PDFロック サーバー起動: http://localhost:${PORT}`);
});
