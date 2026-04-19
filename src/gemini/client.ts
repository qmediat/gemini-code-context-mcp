/**
 * @google/genai client factory — builds a GoogleGenAI instance from the resolved auth profile.
 */

import { GoogleGenAI } from '@google/genai';
import type { AuthProfile } from '../types.js';

export function createGeminiClient(profile: AuthProfile): GoogleGenAI {
  switch (profile.kind) {
    case 'api-key':
      return new GoogleGenAI({ apiKey: profile.apiKey });
    case 'vertex':
      // Vertex path implicitly uses ADC (gcloud application-default credentials).
      // Set GEMINI_USE_VERTEX=true + GOOGLE_CLOUD_PROJECT to route through here.
      return new GoogleGenAI({
        vertexai: true,
        project: profile.project,
        location: profile.location,
      });
  }
}
