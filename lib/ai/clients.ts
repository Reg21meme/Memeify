import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export const openai =
  process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

export const genai =
  process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// <-- updated defaults to your requested models
export const OPENAI_VISION_MODEL =
  process.env.OPENAI_VISION_MODEL || "gpt-5.1";

export const GEMINI_MODEL =
  process.env.GEMINI_MODEL || "gemini-2.5-pro";
