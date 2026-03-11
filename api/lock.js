const Busboy = require('busboy');
const archiver = require('archiver');
archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));
const crypto = require('crypto');
const { PassThrough } = require('stream');

function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const files = [];
    const busboy = Busboy({ headers: req.headers });

    busboy.on('file', (fieldname, file, info) => {
      const { filename } = info;
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        files.push({
          name: filename,
          buffer: Buffer.concat(chunks)
        });
      });
    });

    busboy.on('finish', () => resolve(files));
    busboy.on('error', reject);

    req.pipe(busboy);
  });
}

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
      archive.append(file.buffer, { name: file.name });
    }

    archive.finalize();
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const files = await parseMultipart(req);

    if (files.length === 0) {
      return res.status(400).json({ error: 'ファイルがアップロードされていません' });
    }

    const password = generatePassword();
    const zipBuffer = await createEncryptedZip(files, password);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const zipFilename = `locked_${timestamp}.zip`;

    res.setHeader('Content-Type', 'application/json');
    res.json({
      password: password,
      zipFilename: zipFilename,
      zipBase64: zipBuffer.toString('base64'),
      fileCount: files.length
    });
  } catch (err) {
    console.error('ZIP作成エラー:', err);
    res.status(500).json({ error: 'ZIP作成に失敗しました: ' + err.message });
  }
};
