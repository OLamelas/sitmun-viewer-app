import { AppLayer } from '@api/model/app-cfg';

import { isProfileLayerQueryable } from './profile-layer-queryable';

describe('isProfileLayerQueryable', () => {
  const base: AppLayer = {
    id: 'layer/x',
    title: 'T',
    layers: ['a'],
    service: 'service/1'
  };

  it('returns true when queryableFeatureEnabled is omitted (legacy profile)', () => {
    expect(isProfileLayerQueryable(base)).toBe(true);
  });

  it('returns true when queryableFeatureEnabled is true', () => {
    expect(isProfileLayerQueryable({ ...base, queryableFeatureEnabled: true })).toBe(true);
  });

  it('returns false when queryableFeatureEnabled is false', () => {
    expect(isProfileLayerQueryable({ ...base, queryableFeatureEnabled: false })).toBe(false);
  });
});
