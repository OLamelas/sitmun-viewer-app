import {
  Component,
  Inject,
  Injectable,
  ChangeDetectionStrategy
} from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog } from '@angular/material/dialog';

import { finalize, Observable } from 'rxjs';

export interface MessageBoxConfirmOptions {
  cancelLabel?: string;
  confirmLabel?: string;
  destructive?: boolean;
  signal?: AbortSignal;
}

@Injectable()
export class MessageBoxService {
  constructor(public dialog: MatDialog) {}

  confirm(
    title: string,
    message: string,
    options: MessageBoxConfirmOptions = {}
  ): Observable<boolean> {
    const dialog = this.dialog
      .open(MessageBoxDialogComponent, {
        autoFocus: options.destructive ? '.sitmun-message-box-cancel' : 'first-tabbable',
        restoreFocus: true,
        data: {
          title: title,
          message: message,
          type: MessageBoxType.CONFIRM,
          cancelLabel: options.cancelLabel ?? 'Cancelar',
          confirmLabel: options.confirmLabel ?? 'Continuar',
          destructive: options.destructive ?? false
        }
      });
    const abort = () => dialog.close(false);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    return dialog.afterClosed().pipe(finalize(() => options.signal?.removeEventListener('abort', abort)));
  }

  alert(title: string, message: string): Observable<boolean> {
    return this.dialog
      .open(MessageBoxDialogComponent, {
        data: {
          title: title,
          message: message,
          type: MessageBoxType.ALERT
        }
      })
      .afterClosed();
  }
}

export enum MessageBoxType {
  CONFIRM,
  ALERT
}

@Component({
  standalone: false,
  changeDetection: ChangeDetectionStrategy.Eager,
  templateUrl: './message-box-dialog-component.html'
})
export class MessageBoxDialogComponent {
  title: string;
  message: string;
  type: MessageBoxType;
  cancelLabel: string;
  confirmLabel: string;
  destructive: boolean;

  types = MessageBoxType;

  constructor(@Inject(MAT_DIALOG_DATA) public data: any) {
    this.title = this.data.title;
    this.message = this.data.message;
    this.type = this.data.type;
    this.cancelLabel = this.data.cancelLabel ?? 'Cancelar';
    this.confirmLabel = this.data.confirmLabel ?? 'Continuar';
    this.destructive = this.data.destructive ?? false;
  }
}
