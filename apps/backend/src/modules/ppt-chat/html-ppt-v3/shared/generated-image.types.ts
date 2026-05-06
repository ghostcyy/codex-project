export type GeneratedImageAsset = {
  slideIndex: number;
  slotIndex: number;
  relativePath: string;
  absolutePath?: string;
  prompt: string;
  source: "minimax" | "fallback";
  warning?: string;
};

export type GeneratedImageMap = Record<string, GeneratedImageAsset>;

export function generatedImageKey(slideIndex: number, slotIndex: number) {
  return `${slideIndex}:${slotIndex}`;
}

export function getGeneratedImage(
  generatedImages: GeneratedImageMap | undefined,
  slideIndex: number,
  slotIndex: number
) {
  return generatedImages?.[generatedImageKey(slideIndex, slotIndex)] ?? null;
}
