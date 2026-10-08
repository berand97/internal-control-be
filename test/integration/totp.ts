import { generate } from 'otplib';

const STEP_MS = 30_000;
const MARGIN_MS = 2_000;

export const freshTotp = async (secret: string): Promise<string> => {
  const left = STEP_MS - (Date.now() % STEP_MS);
  if (left < MARGIN_MS) {
    await new Promise((resolve) => setTimeout(resolve, left + 100));
  }
  return generate({ secret });
};
