import { editingTask } from './wfs-editing-identity';
import type { AppCfg } from '../api/model/app-cfg';

describe('WFS edition provenance', () => {
  const endpoint = 'http://localhost/middleware/proxy/1/2/WFS/5/8';
  function fixture() {
    const task = { id: 'task/7', type: 'edition', typeId: 0, scope: 'feat-edit', layer: 'layer/8', url: endpoint,
      parameters: { typename: { value: 'app:roads' } } };
    const profile = { application: { id: 1, territoryId: 2 }, trees: [], tasks: [task],
      layers: [{ id: 'layer/8', service: 'service/5', layers: ['app:roads'] }],
      services: [{ id: 'service/5', type: 'WFS' }] } as unknown as AppCfg;
    const native: any = { id: 'runtime', type: 'WFS', url: endpoint, featureType: ['app:roads'], options: { profileLayerId: 'layer/8' } };
    return { profile, native, task };
  }

  it('requires the edition contract, cartography provenance and exact mediated destination', () => {
    const f = fixture(); expect(editingTask(f.profile, f.native)).toBe(f.task);
    for (const url of ['http://remote.test/wfs', endpoint.replace('/5/8', '/6/8'), endpoint.replace('/1/2/', '/1/3/')]) {
      f.native.url = url; expect(editingTask(f.profile, f.native)).toBeUndefined();
    }
    f.native.url = endpoint; f.native.options.profileLayerId = undefined;
    expect(editingTask(f.profile, f.native)).toBeUndefined();
  });

  it('does not grant permission from a basic tool, db-edit, title, auxiliary copy or old profile', () => {
    for (const patch of [{ type: undefined }, { scope: undefined }, { scope: 'db-edit' }, { layer: undefined }, { typeId: 1 }]) {
      const f = fixture(); Object.assign(f.task, patch); expect(editingTask(f.profile, f.native)).toBeUndefined();
    }
    const f = fixture(); f.native.type = 'WMS'; expect(editingTask(f.profile, f.native)).toBeUndefined();
    f.native.type = 'WFS'; f.native.wmsLayer = {}; expect(editingTask(f.profile, f.native)).toBeUndefined();
  });
});
