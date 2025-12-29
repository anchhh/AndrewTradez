
import { GoogleGenAI, Type } from "@google/genai";
import { SignalAnalysis } from "../types";

// Always use a named parameter for apiKey and access process.env.API_KEY directly as per guidelines.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const analyzeMarketSignal = async (marketContext: string): Promise<SignalAnalysis> => {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Analyze this market context for a trading signal: "${marketContext}"`,
    config: {
      systemInstruction: `You are MERCURY AI, an institutional-grade trading mentor. 
      Analyze the provided market context and return a structured trading signal.
      Be concise, brutally honest, and focused on risk management.
      The output must be JSON.`,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          bias: { type: Type.STRING, enum: ['BULLISH', 'BEARISH', 'NEUTRAL'] },
          confidence: { type: Type.NUMBER, description: 'Percentage 0-100' },
          reasoning: { type: Type.STRING },
          levels: {
            type: Type.OBJECT,
            properties: {
              entry: { type: Type.STRING },
              stop: { type: Type.STRING },
              target: { type: Type.STRING }
            },
            required: ['entry', 'stop', 'target']
          }
        },
        required: ['bias', 'confidence', 'reasoning', 'levels']
      }
    }
  });

  // response.text is a property getter, not a function. Accessing it directly.
  const text = response.text;
  if (!text) {
    throw new Error("MERCURY_AI: Failed to generate signal text.");
  }
  return JSON.parse(text);
};

export const chatWithMentor = async (history: {role: string, parts: {text: string}[]}[], message: string) => {
  const chat = ai.chats.create({
    model: 'gemini-3-flash-preview',
    config: {
      systemInstruction: "You are the head mentor at MERCURY, an elite trading circle. You speak in a clinical, sharp, and high-status tone. You focus on liquidity, order flow, and psychology. Keep answers brief and professional."
    }
  });

  const response = await chat.sendMessage({ message });
  // response.text is a property getter.
  return response.text || '';
};
