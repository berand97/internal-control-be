import { PASSWORD_POLICY_REGEX } from '../../common/validation/password.constants.js';
import { generateTemporaryPassword } from './generate-temporary-password.js';

describe('generateTemporaryPassword', () => {
  it('cumple la política institucional en cada generación', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(generateTemporaryPassword()).toMatch(PASSWORD_POLICY_REGEX);
    }
  });
});
