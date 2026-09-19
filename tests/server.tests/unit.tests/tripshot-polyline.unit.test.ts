import { decodePolyline } from '../../../server/services/tripshot-api';

test('decodes the canonical route geometry example', () => {
  expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
    { lat: 38.5, lng: -120.2 },
    { lat: 40.7, lng: -120.95 },
    { lat: 43.252, lng: -126.453 }
  ]);
});

test.each(['_', '?', '______?', '!?', '\u0100?'])(
  'rejects malformed geometry %j instead of looping beyond the input',
  (value) => {
    expect(() => decodePolyline(value)).toThrow('Invalid encoded polyline');
  }
);
