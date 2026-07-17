import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env
dotenv.config({ path: path.join(__dirname, '.env') });

const KEY_STRING = process.env.PDF_ENCRYPTION_KEY;
if (!KEY_STRING) {
  console.error("CRITICAL: PDF_ENCRYPTION_KEY is not set in environment variables!");
  process.exit(1);
}
// Derive a 32-byte key using SHA-256
const key = crypto.createHash('sha256').update(KEY_STRING).digest();

const srcDir = path.join(__dirname, '../public/pdf-library');
const destDir = path.join(__dirname, 'secure-pdf-library');

if (!fs.existsSync(destDir)) {
  fs.mkdirSync(destDir, { recursive: true });
}

const encryptPDFsInDir = (dirPath, targetDirPath) => {
  if (!fs.existsSync(dirPath)) return;
  try {
    const files = fs.readdirSync(dirPath);
    const pdfFiles = files.filter(f => f.toLowerCase().endsWith('.pdf'));
    
    if (pdfFiles.length === 0) return;
    console.log(`Found ${pdfFiles.length} PDF books to encrypt in "${dirPath}".`);
    
    pdfFiles.forEach(file => {
      const srcPath = path.join(dirPath, file);
      const destPath = path.join(targetDirPath, file + '.enc');
      
      console.log(`Encrypting "${file}"...`);
      
      try {
        const data = fs.readFileSync(srcPath);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        
        const encryptedData = Buffer.concat([
          iv, 
          cipher.update(data), 
          cipher.final()
        ]);
        
        fs.writeFileSync(destPath, encryptedData);
        console.log(`Successfully encrypted and saved to: ${destPath}`);
        
        fs.unlinkSync(srcPath);
        console.log(`Deleted original: ${srcPath}`);
      } catch (err) {
        console.error(`Error encrypting file "${file}":`, err);
      }
    });
  } catch (err) {
    console.error(`Error reading directory "${dirPath}":`, err);
  }
};

// Encrypt files from source folder if it exists
encryptPDFsInDir(srcDir, destDir);

// Encrypt files directly in secure-pdf-library if they exist
encryptPDFsInDir(destDir, destDir);

console.log("Encryption process completed.");
