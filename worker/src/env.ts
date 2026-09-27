export interface Env {
  NEMESIS_KV: KVNamespace;
  GEMINI_API_KEY: string;
  GRADIUM_API_KEY: string;
  ELEVENLABS_API_KEY?: string;
  /** Signs forge tokens; falls back to deriving from GEMINI_API_KEY when unset. */
  FORGE_TOKEN_SECRET?: string;
  GEMINI_TEXT_MODEL: string;
  GEMINI_IMAGE_MODEL: string;
  MUSIC_PROVIDER: "lyria" | "elevenlabs";
  ALLOWED_ORIGINS: string;
}
