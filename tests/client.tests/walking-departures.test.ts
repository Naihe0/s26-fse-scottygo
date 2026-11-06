import type { ILatLng } from '../../common/map.interface';
import type { IPrediction } from '../../common/transit.interface';
import { keyArrivalRows } from '../../client/scripts/utils/arrival-identity';
import { reconcileWalkingDepartures, walkingConnection, walkingMapLinks } from '../../client/scripts/utils/walking-departures';

const row = (overrides: Partial<IPrediction> = {}): IPrediction => ({
  stopId:'7117', routeId:'61C', vid:'4001', occurrenceId:'trip:visit:1',
  predictedArrivalTime:Date.parse('2026-11-06T07:00:00Z'), isDelayed:false, minutes:5,
  ...overrides
});
const keys = (rows: IPrediction[]) => [...keyArrivalRows(rows).values()];

describe('walking selected departure reconciliation', () => {
  test('updates a stable visit ETA and vehicle without changing selection order', () => {
    const first = row();
    const second = row({occurrenceId:'trip:visit:2',vid:'4002'});
    const changed = {...first,vid:'4003',predictedArrivalTime:first.predictedArrivalTime+120000};
    expect(reconcileWalkingDepartures([second,first],keys([second,first]),[changed,second]))
      .toEqual({rows:[second,changed],missingKeys:[]});
    expect(first.vid).toBe('4001');
  });
  test('missing visits retain the last estimate and do not select another bus on the same route', () => {
    const previous = row();
    const selected = keys([previous]);
    expect(reconcileWalkingDepartures([previous],selected,[row({occurrenceId:'different',vid:'4002'})]))
      .toEqual({rows:[previous],missingKeys:selected});
    expect(reconcileWalkingDepartures([previous],selected,[]).missingKeys).toEqual(selected);
  });
  test('loop visits use the full board keys and cannot match an adjacent same-vehicle arrival', () => {
    const first = row({occurrenceId:undefined});
    const later = {...first,predictedArrivalTime:first.predictedArrivalTime+600000};
    const boardKeys = keys([first,later]);
    expect(reconcileWalkingDepartures([later],[boardKeys[1]],[first,later]))
      .toEqual({rows:[later],missingKeys:[]});
    expect(reconcileWalkingDepartures([later],[boardKeys[1]],[first]))
      .toEqual({rows:[later],missingKeys:[boardKeys[1]]});
  });
  test('an unambiguous vehicle may move its ETA but a newly ambiguous one remains missing', () => {
    const previous = row({occurrenceId:undefined});
    const selected = keys([previous]);
    const changed = {...previous,predictedArrivalTime:previous.predictedArrivalTime+60000};
    expect(reconcileWalkingDepartures([previous],selected,[changed]).rows).toEqual([changed]);
    expect(reconcileWalkingDepartures([previous],selected,[previous,changed]))
      .toEqual({rows:[previous],missingKeys:selected});
  });
  test('scheduled arrivals without occurrence IDs require the same exact scheduled time', () => {
    const previous = row({occurrenceId:undefined,vid:'Scheduled'});
    const selected = keys([previous]);
    expect(reconcileWalkingDepartures([previous],selected,[{...previous}]).missingKeys).toEqual([]);
    expect(reconcileWalkingDepartures([previous],selected,[{...previous,predictedArrivalTime:previous.predictedArrivalTime+60000}]).missingKeys)
      .toEqual(selected);
  });
  test.each([NaN,Infinity,1e100])('invalid fresh time %s cannot overwrite a last-known visit', time => {
    const previous = row();
    const selected = keys([previous]);
    expect(reconcileWalkingDepartures([previous],selected,[{...previous,predictedArrivalTime:time}]))
      .toEqual({rows:[previous],missingKeys:selected});
  });
  test('mismatched or duplicated supplied keys fail closed instead of selecting a different route or stop', () => {
    const previous = row();
    for (const candidate of [row({routeId:'61A'}),row({stopId:'4407'})]) {
      const wrongKeys = keys([candidate]);
      expect(reconcileWalkingDepartures([previous],wrongKeys,[candidate]))
        .toEqual({rows:[previous],missingKeys:wrongKeys});
    }
    const key = keys([previous])[0];
    expect(reconcileWalkingDepartures([previous,previous],[key,key],[previous]).missingKeys).toEqual([key,key]);
    expect(reconcileWalkingDepartures([previous],[],[previous])).toEqual({rows:[previous],missingKeys:['']});
  });
});

describe('boarding buffer calculation', () => {
  const arrive = Date.parse('2026-11-06T07:00:00Z');
  test.each([
    [-1,0,'May leave before you arrive',true],
    [0,0,'Tight connection',true],
    [0.99,0,'Tight connection',true],
    [1,0,'About 1 min to spare',false],
    [1.99,2,'Less than 2 min boarding buffer',true],
    [2,2,'Tight connection',true],
    [3,2,'About 1 min to spare',false],
    [4,5,'Less than 5 min boarding buffer',true],
    [7,5,'About 2 min to spare',false]
  ] as const)('%s minutes before bus with %s minute buffer', (margin,buffer,label,tight) => {
    expect(walkingConnection(arrive+margin*60000,arrive,buffer,true)).toEqual({label,tight});
  });
  test('unavailable or invalid data never produces a boarding assurance', () => {
    expect(walkingConnection(arrive+600000,arrive,2,false)).toBeNull();
    for(const bad of [NaN,Infinity,1e100]) {
      expect(walkingConnection(bad,arrive,2,true)).toBeNull();
      expect(walkingConnection(arrive,bad,2,true)).toBeNull();
    }
    expect(walkingConnection(arrive,arrive,3 as 2,true)).toBeNull();
  });
});

describe('external walking map links', () => {
  const destination = {lat:40.4419,lng:-79.9417};
  test('links use official HTTPS hosts, exact destination and walking mode without rider GPS', () => {
    const links = walkingMapLinks(destination)!;
    const apple = new URL(links.apple), google = new URL(links.google);
    expect(apple.origin+apple.pathname).toBe('https://maps.apple.com/directions');
    expect(google.origin+google.pathname).toBe('https://www.google.com/maps/dir/');
    expect(apple.searchParams.get('destination')).toBe('40.4419,-79.9417');
    expect(google.searchParams.get('destination')).toBe('40.4419,-79.9417');
    expect(apple.searchParams.get('mode')).toBe('walking');
    expect(google.searchParams.get('travelmode')).toBe('walking');
    expect(google.searchParams.get('api')).toBe('1');
    expect(apple.searchParams.has('source')).toBe(false);
    expect(google.searchParams.has('origin')).toBe(false);
  });
  test('an explicitly planned origin is retained in both maps without page credentials or filters', () => {
    const origin = {lat:40.4433,lng:-79.9436};
    const links = walkingMapLinks(destination,origin)!;
    expect(new URL(links.apple).searchParams.get('source')).toBe('40.4433,-79.9436');
    expect(new URL(links.google).searchParams.get('origin')).toBe('40.4433,-79.9436');
    expect(JSON.stringify(links)).not.toMatch(/token|account|routeId|stopId|secret/);
  });
  test.each([{lat:NaN,lng:1},{lat:91,lng:1},{lat:1,lng:-181},{lat:1,lng:Infinity},null])(
    'invalid destination or supplied origin %j never silently falls back to another point', point => {
      expect(walkingMapLinks(point as ILatLng)).toBeNull();
      expect(walkingMapLinks(destination,point as ILatLng)).toBeNull();
    });
  test('zero and geographic boundaries remain valid coordinates', () => {
    expect(walkingMapLinks({lat:0,lng:0})).not.toBeNull();
    expect(walkingMapLinks({lat:-90,lng:180})).not.toBeNull();
  });
});
