import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

let encoder: Tiktoken | null = null;

/** Token count with the o200k encoding: one consistent measure regardless of executor model. */
export function countTokens(text: string): number {
  encoder ??= new Tiktoken(o200k_base);
  return encoder.encode(text).length;
}
