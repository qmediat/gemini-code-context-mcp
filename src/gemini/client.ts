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
      return new GoogleGenAI({
        vertexai: true,
        project: profile.project,
        location: profile.location,
      });
    case 'adc':
      // SDK picks up GOOGLE_APPLICATION_CREDENTIALS automatically when vertexai=true
      // is NOT set; this branch is reserved for non-Vertex ADC flows when Google adds support.
      return new GoogleGenAI({});
  }
}
