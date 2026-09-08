import { describe, expect, it } from 'vitest';
import { parseDriveFolderId } from './parse-drive-folder-id.js';

describe('parseDriveFolderId', () => {
  it('deja el id crudo', () => {
    expect(parseDriveFolderId('1AbCDeF-xyz')).toBe('1AbCDeF-xyz');
  });

  it('extrae el id de la URL de Drive', () => {
    expect(
      parseDriveFolderId(
        'https://drive.google.com/drive/folders/1AbCDeF-xyz?usp=sharing',
      ),
    ).toBe('1AbCDeF-xyz');
  });

  it('extrae el id de open?id=', () => {
    expect(
      parseDriveFolderId('https://drive.google.com/open?id=1AbCDeF-xyz'),
    ).toBe('1AbCDeF-xyz');
  });

  it('convierte vacío en null', () => {
    expect(parseDriveFolderId('')).toBeNull();
    expect(parseDriveFolderId(null)).toBeNull();
  });
});
