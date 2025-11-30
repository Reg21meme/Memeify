import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function getImageVector(imageInput: string | Buffer): Promise<number[]> {
  
  let filePath = '';
  let tempFileCreated = false;

  // Handle Buffer vs Path inputs
  if (Buffer.isBuffer(imageInput)) {
    const tempDir = os.tmpdir();
    filePath = path.join(tempDir, `upload-${Date.now()}.jpg`);
    fs.writeFileSync(filePath, imageInput);
    tempFileCreated = true;
  } else {
    filePath = imageInput;
  }

  try {
    const scriptPath = path.join(process.cwd(), 'scripts', 'vectorize.py');
    
    // IMPORTANT: Using "python3" instead of "python" is safer on Mac/Linux.
    // If you are on Windows and 'python3' fails, change this back to 'python'
    const pythonCommand = process.platform === "win32" ? "python" : "python3";
    
    const command = `${pythonCommand} "${scriptPath}" "${filePath}"`;
    
    // Execute safely
    const rawOutput = execSync(command, { encoding: 'utf-8' });

    // Parse the markers
    const startMarker = "###VECTOR_START###";
    const endMarker = "###VECTOR_END###";

    const startIndex = rawOutput.indexOf(startMarker);
    const endIndex = rawOutput.indexOf(endMarker);

    if (startIndex === -1 || endIndex === -1) {
      console.warn("AI Model Warning: No vector returned (Face not found or error).");
      return [];
    }

    const jsonString = rawOutput.substring(startIndex + startMarker.length, endIndex).trim();
    return JSON.parse(jsonString);

  } catch (error) {
    console.error("Vectorization Error:", error);
    return [];
  } finally {
    // Cleanup temp file
    if (tempFileCreated && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
  }
}