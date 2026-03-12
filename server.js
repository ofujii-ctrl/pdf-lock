const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const nodemailer = require('nodemailer');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// アップロード先（/tmp）
const upload = multer({ dest: '/tmp/pdf-uploads/' });

// セッション管理（暗号化済みPDFの一時保管）
const sessions = {};

// 30分で自動クリーンアップ
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of Object.entries(sessions)) {
    if (now - session.created > 30 * 60 * 1000) {
      session.files.forEach(f => {
        try { fs.unlinkSync(f.encryptedPath); } catch(e) {}
        try { fs.unlinkSync(f.uploadPath); } catch(e) {}
      });
      delete sessions[id];
    }
  }
}, 5 * 60 * 1000);

// パスワード生成（紛らわしい文字を除外）
function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ===== API =====

// PDF暗号化
app.post('/api/lock', upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'ファイルがアップロードされていません' });
    }

    // PDFのみ許可
    for (const file of req.files) {
      if (!file.originalname.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({ error: `PDFファイルのみ対応しています: ${file.originalname}` });
      }
    }

    const pwLength = parseInt(req.body.pwLength) || 12;
    const password = req.body.password || generatePassword(pwLength);
    const sessionId = crypto.randomUUID();
    const files = [];

    for (const file of req.files) {
      const encryptedPath = `/tmp/enc_${file.filename}.pdf`;

      // qpdfでAES-256暗号化
      execSync(
        `qpdf --encrypt "${password}" "${password}" 256 -- "${file.path}" "${encryptedPath}"`,
        { timeout: 30000 }
      );

      files.push({
        originalName: file.originalname,
        uploadPath: file.path,
        encryptedPath: encryptedPath,
        size: fs.statSync(encryptedPath).size
      });
    }

    sessions[sessionId] = { files, password, created: Date.now() };

    res.json({
      success: true,
      sessionId,
      password,
      files: files.map(f => ({ name: f.originalName, size: f.size }))
    });
  } catch (err) {
    console.error('暗号化エラー:', err);
    res.status(500).json({ error: 'PDF暗号化に失敗しました: ' + err.message });
  }
});

// 暗号化PDFダウンロード
app.get('/api/download/:sessionId/:index', (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: 'セッション期限切れです' });

  const file = session.files[parseInt(req.params.index)];
  if (!file) return res.status(404).json({ error: 'ファイルが見つかりません' });

  res.download(file.encryptedPath, file.originalName);
});

// 添付メール送信（暗号化PDF添付）
app.post('/api/send-email', async (req, res) => {
  try {
    const { sessionId, to, cc, subject, body } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(400).json({ error: 'セッション期限切れです。再度ロックしてください。' });

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailUser || !gmailPass) {
      return res.status(500).json({ error: 'Gmail設定がされていません（環境変数を確認）' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass }
    });

    const attachments = session.files.map(f => ({
      filename: f.originalName,
      path: f.encryptedPath
    }));

    await transporter.sendMail({
      from: gmailUser,
      to,
      cc: cc || undefined,
      subject,
      text: body,
      attachments
    });

    res.json({ success: true });
  } catch (err) {
    console.error('メール送信エラー:', err);
    res.status(500).json({ error: 'メール送信に失敗しました: ' + err.message });
  }
});

// パスワード通知メール送信
app.post('/api/send-password', async (req, res) => {
  try {
    const { sessionId, to, cc } = req.body;
    const session = sessions[sessionId];
    if (!session) return res.status(400).json({ error: 'セッション期限切れです。' });

    const gmailUser = process.env.GMAIL_USER;
    const gmailPass = process.env.GMAIL_APP_PASSWORD;
    if (!gmailUser || !gmailPass) {
      return res.status(500).json({ error: 'Gmail設定がされていません（環境変数を確認）' });
    }

    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: gmailUser, pass: gmailPass }
    });

    const fileNames = session.files.map(f => `  ・${f.originalName}`).join('\n');

    await transporter.sendMail({
      from: gmailUser,
      to,
      cc: cc || undefined,
      subject: '【パスワード通知】先ほどお送りしたファイルについて',
      text: `お世話になっております。\n\n先ほどお送りしたファイルのパスワードをお知らせいたします。\n\n対象ファイル:\n${fileNames}\n\nパスワード: ${session.password}\n\nPDFを開く際に上記パスワードを入力してください。\nご不明な点がございましたら、お気軽にお問い合わせください。\n\nよろしくお願いいたします。`
    });

    res.json({ success: true });
  } catch (err) {
    console.error('パスワード通知エラー:', err);
    res.status(500).json({ error: 'パスワード通知メール送信に失敗しました: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`PDFロック サーバー起動: http://localhost:${PORT}`);
});
