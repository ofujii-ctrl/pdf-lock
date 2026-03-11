const nodemailer = require('nodemailer');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { to, zipFilename, password, smtpHost, smtpPort, smtpUser, smtpPass, fromEmail } = req.body;

  if (!to || !password) {
    return res.status(400).json({ error: '宛先とパスワードは必須です' });
  }

  // 環境変数またはリクエストからSMTP設定を取得
  const host = smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(smtpPort || process.env.SMTP_PORT || '587');
  const user = smtpUser || process.env.SMTP_USER || '';
  const pass = smtpPass || process.env.SMTP_PASS || '';
  const from = fromEmail || process.env.SMTP_FROM || user;

  if (!user || !pass) {
    return res.status(400).json({ error: 'SMTP認証情報が設定されていません。SMTP設定を入力するか、環境変数を設定してください。' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: false,
      auth: { user, pass }
    });

    await transporter.sendMail({
      from,
      to,
      subject: `【パスワード通知】${zipFilename || 'ファイル'}のパスワード`,
      text: `お世話になっております。\n\n先ほどお送りしたファイル（${zipFilename || '添付ファイル'}）のパスワードをお知らせいたします。\n\nパスワード: ${password}\n\nお手数ですが、上記パスワードにてファイルを解凍してください。\nご不明な点がございましたら、お気軽にお問い合わせください。\n\nよろしくお願いいたします。`
    });

    res.json({ message: 'パスワードを送信しました' });
  } catch (err) {
    console.error('メール送信エラー:', err);
    res.status(500).json({ error: 'メール送信に失敗しました: ' + err.message });
  }
};
