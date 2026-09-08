import { describe, expect, it } from 'vitest';
import { flattenStoragePatch } from './update-storage-settings.dto.js';

describe('flattenStoragePatch', () => {
  it('mapea googleClientId y googleClientSecret', () => {
    expect(
      flattenStoragePatch({
        googleClientId: 'id.apps.googleusercontent.com',
        googleClientSecret: 'GOCSPX-secret',
      }),
    ).toEqual({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('acepta clientId/clientSecret como alias de Google', () => {
    expect(
      flattenStoragePatch({
        clientId: 'id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
    ).toEqual({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('acepta google anidado', () => {
    expect(
      flattenStoragePatch({
        google: {
          clientId: 'id.apps.googleusercontent.com',
          clientSecret: 'GOCSPX-secret',
        },
      }),
    ).toEqual({
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('ignora Client ID enmascarado del status', () => {
    expect(
      flattenStoragePatch({
        googleClientId: 'id****om',
        googleClientSecret: 'GOCSPX-secret',
        googleConnected: false,
        needsOauth: true,
      }),
    ).toEqual({
      googleClientSecret: 'GOCSPX-secret',
    });
  });

  it('acepta folderId o URL de Drive como carpeta de Google', () => {
    expect(
      flattenStoragePatch({
        folderId:
          'https://drive.google.com/drive/folders/1AbCDeF-xyz?usp=sharing',
      }),
    ).toEqual({
      googleFolderId: '1AbCDeF-xyz',
    });
  });

  it('no escribe clientId en OneDrive si el driver no es onedrive', () => {
    expect(
      flattenStoragePatch({
        driver: 'google_drive',
        clientId: 'id.apps.googleusercontent.com',
        clientSecret: 'GOCSPX-secret',
      }),
    ).toEqual({
      driver: 'google_drive',
      googleClientId: 'id.apps.googleusercontent.com',
      googleClientSecret: 'GOCSPX-secret',
    });
  });
});
