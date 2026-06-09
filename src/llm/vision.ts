/**
 * Cross-provider image content block for HumanMessage.
 *
 * The `image_url` form with a data-URL is accepted by both ChatAnthropic (via LangChain coercion)
 * and ChatOpenAI/OpenRouter. The exact working form for Anthropic Opus is confirmed by Spike S2 —
 * if needed, a per-provider branch will live here.
 */
export interface ImageBlock {
  type: "image_url";
  image_url: { url: string };
  // Open content block (compatibility with LangChain message types).
  [key: string]: unknown;
}

export function imageBlock(dataB64: string, mediaType = "image/png"): ImageBlock {
  return { type: "image_url", image_url: { url: `data:${mediaType};base64,${dataB64}` } };
}
