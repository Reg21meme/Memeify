import fs from "fs/promises"; import path from "path";
export type Meme = { id: string; name: string; description?: string; imageUrl: string; embedding: number[]; createdAt: string }
const DATA_PATH = path.join(process.cwd(), "data", "memes.json")

export async function readMemes(): Promise<Meme[]> { 
    try { 
        return JSON.parse(await fs.readFile(DATA_PATH, "utf8")) } 
    catch (e:any) { 
        if (e.code==="ENOENT") return []; throw e 
        } 
}

export async function writeMemes(memes: Meme[]) { 
    await fs.mkdir(path.dirname(DATA_PATH), { recursive: true }); 
    await fs.writeFile(DATA_PATH, JSON.stringify(memes,null,2),"utf8") 
}