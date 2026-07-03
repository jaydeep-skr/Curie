import fs from 'node:fs/promises';
import path from 'node:path';
import fg from 'fast-glob';
import mammoth from 'mammoth';
import pdf from 'pdf-parse';
import * as XLSX from 'xlsx';

const textExtensions = new Set([
  '.md',
  '.txt',
  '.csv',
  '.py',
  '.json',
  '.js',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml'
]);

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const officeExtensions = new Set(['.docx', '.pptx']);

export type VaultDocument = {
  path: string;
  content: string;
  updatedAt: number;
};

export async function listVaultFiles(vaultPath: string): Promise<string[]> {
  return fg(['**/*'], {
    cwd: vaultPath,
    onlyFiles: true,
    absolute: true,
    suppressErrors: true,
    ignore: ['.obsidian/**', '.trash/**', 'node_modules/**']
  });
}

export async function readVaultDocument(filePath: string): Promise<VaultDocument | null> {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fs.stat(filePath);

  if (textExtensions.has(ext)) {
    const content = await fs.readFile(filePath, 'utf8');
    return { path: filePath, content, updatedAt: stat.mtimeMs };
  }

  if (ext === '.pdf') {
    const buffer = await fs.readFile(filePath);
    const parsed = await pdf(buffer);
    return { path: filePath, content: parsed.text, updatedAt: stat.mtimeMs };
  }

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return { path: filePath, content: result.value, updatedAt: stat.mtimeMs };
  }

  if (ext === '.pptx') {
    return {
      path: filePath,
      content: 'PPTX file detected. Text extraction is not enabled yet; use filename and neighboring context only.',
      updatedAt: stat.mtimeMs
    };
  }

  if (ext === '.xlsx') {
    const workbook = XLSX.readFile(filePath);
    const content = workbook.SheetNames.map((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_csv(sheet);
      return `Sheet: ${sheetName}\n${rows}`;
    }).join('\n\n');

    return { path: filePath, content, updatedAt: stat.mtimeMs };
  }

  if (imageExtensions.has(ext)) {
    return {
      path: filePath,
      content: `Image asset: ${path.basename(filePath)}. Visual extraction is not enabled yet; use adjacent notes and filename context.`,
      updatedAt: stat.mtimeMs
    };
  }

  if (officeExtensions.has(ext)) {
    return null;
  }

  return {
    path: filePath,
    content: `Binary or unsupported file: ${path.basename(filePath)}`,
    updatedAt: stat.mtimeMs
  };
}
