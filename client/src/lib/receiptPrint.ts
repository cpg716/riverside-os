import { transform } from "receiptline";
import {
  printRawEscPosBase64,
  type HardwarePrinterTarget,
} from "./printerBridge";

export interface ReceiptPayloadInput {
  escposBase64?: string | null;
  receiptlineMarkdown?: string | null;
}

export interface ReceiptPayloadOptions {
  cpl?: number;
  preferReceiptline?: boolean;
}

export interface PreparedReceiptPayload {
  printableBase64: string;
  source: "receiptline" | "server_escpos";
}

function binaryStringToBase64(value: string) {
  let binary = "";
  for (let i = 0; i < value.length; i += 1) {
    binary += String.fromCharCode(value.charCodeAt(i) & 0xff);
  }
  return btoa(binary);
}

function textToEscposBase64(text: string) {
  const bytes = [
    0x1b, 0x40,
    ...Array.from(text).map((ch) => ch.charCodeAt(0) & 0xff),
    0x0a, 0x0a, 0x0a,
    0x1d, 0x56, 0x41, 0x00,
  ];
  return btoa(String.fromCharCode(...bytes));
}

export function receiptlineToEscposBase64(
  markdown: string,
  options: ReceiptPayloadOptions = {},
) {
  const command = transform(markdown, {
    cpl: options.cpl ?? 48,
    encoding: "cp437",
    command: "escpos",
    cutting: true,
    spacing: false,
    margin: "full",
  });
  return binaryStringToBase64(String(command));
}

export function prepareReceiptPayload(
  input: ReceiptPayloadInput,
  options: ReceiptPayloadOptions = {},
): PreparedReceiptPayload {
  const escposBase64 = input.escposBase64?.trim() ?? "";
  const receiptlineMarkdown = input.receiptlineMarkdown?.trim() ?? "";
  const preferReceiptline = options.preferReceiptline ?? false;

  if (preferReceiptline && receiptlineMarkdown) {
    try {
      return {
        printableBase64: receiptlineToEscposBase64(receiptlineMarkdown, options),
        source: "receiptline",
      };
    } catch (error) {
      if (!escposBase64) {
        throw error;
      }
      console.warn("ReceiptLine print transform failed; using server ESC/POS fallback", error);
    }
  }

  if (escposBase64) {
    return {
      printableBase64: escposBase64,
      source: "server_escpos",
    };
  }

  if (receiptlineMarkdown) {
    return {
      printableBase64: receiptlineToEscposBase64(receiptlineMarkdown, options),
      source: "receiptline",
    };
  }

  throw new Error("Receipt printing is unavailable. No printable receipt payload was returned.");
}

export async function printReceiptBase64(
  payloadB64: string,
  target?: HardwarePrinterTarget,
) {
  if (!payloadB64.trim()) {
    throw new Error("Receipt printing is unavailable. No printable receipt payload was returned.");
  }
  await printRawEscPosBase64(payloadB64, target);
}

export async function printReceiptPayload(
  input: ReceiptPayloadInput,
  options: ReceiptPayloadOptions = {},
) {
  const prepared = prepareReceiptPayload(input, options);
  await printReceiptBase64(prepared.printableBase64);
  return prepared;
}

export async function printReceiptText(text: string, target?: HardwarePrinterTarget) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("Receipt text is empty.");
  }
  await printReceiptBase64(textToEscposBase64(text), target);
}
