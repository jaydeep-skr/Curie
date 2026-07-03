declare module 'pdf-parse' {
  type PdfParseResult = {
    text: string;
  };

  export default function pdf(dataBuffer: Buffer): Promise<PdfParseResult>;
}
