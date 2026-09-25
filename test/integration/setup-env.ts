import { testDatabaseUrl } from './global-setup.js';

process.env['DATABASE_URL'] = testDatabaseUrl();
process.env['JWT_ACCESS_SECRET'] ??= 'integration-access-secret';
process.env['JWT_REFRESH_SECRET'] ??= 'integration-refresh-secret';
process.env['MOVEMENT_SIGNING_SECRET'] ??= 'integration-movement-secret';
process.env['SETTINGS_ENCRYPTION_KEY'] ??= 'aW50ZWdyYXRpb24tc2V0dGluZ3Mta2V5LTMyYnl0ZXM=';
process.env['ARGON2_MEMORY_COST'] ??= '1024';
process.env['ARGON2_TIME_COST'] ??= '1';
process.env['ARGON2_PARALLELISM'] ??= '1';
