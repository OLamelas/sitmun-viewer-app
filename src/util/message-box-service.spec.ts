import { MatDialog } from '@angular/material/dialog';
import { Subject } from 'rxjs';
import { MessageBoxService } from './message-box-service';

describe('MessageBoxService confirmation', () => {
  function setup() {
    const closed = new Subject<boolean>();
    const ref = { afterClosed: () => closed.asObservable(), close: jest.fn() };
    const dialog = { open: jest.fn<unknown, [unknown, unknown]>(() => ref) };
    return { closed, ref, dialog, service: new MessageBoxService(dialog as unknown as MatDialog) };
  }

  it('preserves the existing default labels and returns the actual dialog result', () => {
    const { closed, dialog, service } = setup();
    const result = jest.fn();
    service.confirm('Title', 'Message').subscribe(result);
    expect(dialog.open.mock.calls[0][1]).toMatchObject({
      restoreFocus: true, data: { cancelLabel: 'Cancelar', confirmLabel: 'Continuar', destructive: false }
    });
    closed.next(false);
    expect(result).toHaveBeenCalledWith(false);
  });

  it('focuses the non-destructive option and closes on forced context invalidation', () => {
    const { closed, ref, dialog, service } = setup();
    const controller = new AbortController();
    const remove = jest.spyOn(controller.signal, 'removeEventListener');
    const subscription = service.confirm('Title', 'Message', { destructive: true,
      cancelLabel: 'Keep editing', confirmLabel: 'Discard', signal: controller.signal }).subscribe();
    expect(dialog.open.mock.calls[0][1]).toMatchObject({ autoFocus: '.sitmun-message-box-cancel' });
    controller.abort();
    expect(ref.close).toHaveBeenCalledWith(false);
    closed.complete();
    subscription.unsubscribe();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });
});
