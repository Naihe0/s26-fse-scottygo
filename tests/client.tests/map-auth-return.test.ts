/** @jest-environment jsdom */
import {
  mapReturnPath,
  mapSignInPath,
  sanitizeMapViewHash
} from '../../client/scripts/utils/map-auth-return';

test('sign-in and map return preserve only recognized route and filter values', () => {
  const hash =
    '#/map?r=CMU-abc-123&d=20260921&t=0830&s=PRT,CMU&dir=OB&lat=40.412345&lng=-79.923456&token=private&next=https://evil.example';
  const safe = '#/map?r=CMU-abc-123&d=20260921&t=0830&s=PRT%2CCMU&dir=OB';
  expect(mapSignInPath(hash)).toBe(`/auth${safe}`);
  expect(mapReturnPath(hash)).toBe(`/${safe}`);
  expect(sanitizeMapViewHash(hash)).not.toMatch(
    /private|40\.412345|-79\.923456|evil/
  );
});

test.each([
  'https://evil.example/#/map?r=61A',
  '//evil.example',
  '#//evil.example',
  '/account#/map?r=61A',
  '#/account?r=61A',
  '#/map/../../account',
  'javascript:alert(1)',
  '#/map%3Fr%3D61A'
])('rejects non-map handoff %s', (value) => {
  expect(sanitizeMapViewHash(value)).toBeNull();
  expect(mapReturnPath(value)).toBe('/');
  expect(mapSignInPath(value)).toBe('/auth');
});

test('invalid filter values cannot smuggle paths, scripts, dates, or coordinates', () => {
  expect(
    sanitizeMapViewHash(
      '#/map?r=https%3A%2F%2Fevil.example&d=20260230&t=2599&s=PRT,https://evil.example&dir=OB,script'
    )
  ).toBe('#/map?s=PRT&dir=OB');
  expect(sanitizeMapViewHash('#/map?r=40.412345,-79.923456&s=&dir=')).toBe(
    '#/map?s=&dir='
  );
});

test('query redirect/token/location values are ignored when computing the map return', () => {
  history.replaceState(
    null,
    '',
    '/auth?returnTo=https://evil.example&token=secret&lat=40.412345#/map?r=61C'
  );
  expect(mapReturnPath()).toBe('/#/map?r=61C');
  expect(mapSignInPath()).toBe('/auth#/map?r=61C');
});

test('sign-in preserves a public stop link without private URL state', () => {
  const hash =
    '#/map?stop=cmu%3A123-4&lat=40&lng=-80&token=private&next=https://evil.example';
  expect(sanitizeMapViewHash(hash)).toBe('#/map?stop=cmu%3A123-4');
  expect(mapSignInPath(hash)).toBe('/auth#/map?stop=cmu%3A123-4');
  expect(mapReturnPath(hash)).toBe('/#/map?stop=cmu%3A123-4');
});

test.each([
  '#/map?stop=..%2Faccount',
  '#/map?stop=https%3A%2F%2Fevil.example',
  '#/map?stop=123&stop=456',
  '#/map?stop=%3Cscript%3E'
])('drops unsafe or ambiguous stop links: %s', (hash) => {
  expect(sanitizeMapViewHash(hash)).toBe('#/map');
});
