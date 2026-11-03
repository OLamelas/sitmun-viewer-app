import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild
} from '@angular/core';

let nextTitleId = 0;

/** Non-modal map chrome. Content and close decisions belong to its owner. */
@Component({
  selector: 'app-map-feature-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="sitmun-map-feature-panel-toolbar"
      (pointerdown)="startDrag($event)">
      <span
        [id]="titleId"
        class="sitmun-map-feature-panel-title"
        [textContent]="title"></span>
      <span #closeHost></span>
    </div>
    <div #content class="sitmun-map-feature-panel-content"></div>
  `,
  host: {
    class: 'sitmun-map-feature-panel',
    role: 'dialog',
    tabindex: '-1',
    '[attr.aria-labelledby]': 'titleId',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointermove)': 'moveDrag($event)',
    '(pointerup)': 'stopDrag($event)',
    '(pointercancel)': 'stopDrag($event)',
    '(click)': '$event.stopPropagation()',
    '(dblclick)': '$event.stopPropagation()',
    '(wheel)': '$event.stopPropagation()',
    '(keydown)': 'onKeyDown($event)'
  }
})
export class MapFeaturePanelComponent implements AfterViewInit, OnDestroy {
  @ViewChild('content', { static: true }) content!: ElementRef<HTMLElement>;
  @ViewChild('closeHost', { static: true })
  private closeHost!: ElementRef<HTMLElement>;
  readonly titleId = `map-feature-panel-title-${++nextTitleId}`;
  title = '';
  closeLabel = '';
  requestClose: () => void = () => undefined;
  bringToFront: () => void = () => undefined;
  private drag: {
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null = null;
  private resizeObserver?: ResizeObserver;

  constructor(private readonly element: ElementRef<HTMLElement>) {}

  ngAfterViewInit(): void {
    const useSitnaButton =
      typeof customElements !== 'undefined' &&
      !!customElements.get('sitna-button');
    const close = document.createElement(
      useSitnaButton ? 'sitna-button' : 'button'
    ) as HTMLElement;
    if (useSitnaButton) {
      close.setAttribute('variant', 'minimal');
    } else {
      (close as HTMLButtonElement).type = 'button';
    }
    close.className = 'tc-ctl-popup-close sitmun-map-feature-panel-close';
    close.setAttribute('title', this.closeLabel);
    close.setAttribute('aria-label', this.closeLabel);
    close.textContent = this.closeLabel;
    // Native and SITNA buttons emit click for pointer, Enter and Space. A single
    // handler avoids asking twice for a pointerup followed by its click.
    close.addEventListener('click', (event) => {
      // Closing may synchronously destroy the host's propagation listeners.
      event.stopPropagation();
      this.requestClose();
    });
    this.closeHost.nativeElement.appendChild(close);
  }

  initializeBounds(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.place());
      this.resizeObserver.observe(this.element.nativeElement);
      const parent = this.element.nativeElement.parentElement;
      if (parent) this.resizeObserver.observe(parent);
    }
    this.place();
  }

  onPointerDown(event: PointerEvent): void {
    event.stopPropagation();
    this.bringToFront();
  }

  startDrag(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    if (
      event.button !== 0 ||
      target.closest('button, a, input, select, textarea, sitna-button')
    )
      return;
    event.preventDefault();
    const panel = this.element.nativeElement;
    this.drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: panel.offsetLeft,
      top: panel.offsetTop
    };
    panel.setPointerCapture?.(event.pointerId);
  }

  moveDrag(event: PointerEvent): void {
    event.stopPropagation();
    if (!this.drag || this.drag.id !== event.pointerId) return;
    event.preventDefault();
    this.place(
      this.drag.left + event.clientX - this.drag.x,
      this.drag.top + event.clientY - this.drag.y
    );
  }

  stopDrag(event: PointerEvent): void {
    event.stopPropagation();
    if (this.drag?.id !== event.pointerId) return;
    const panel = this.element.nativeElement;
    if (panel.hasPointerCapture?.(event.pointerId))
      panel.releasePointerCapture(event.pointerId);
    this.drag = null;
  }

  onKeyDown(event: KeyboardEvent): void {
    // Keep editor keys out of SITNA; do not trap Tab or modal-dialog events.
    event.stopPropagation();
  }

  place(left?: number, top?: number): void {
    const panel = this.element.nativeElement;
    const parent = panel.parentElement;
    if (!parent) return;
    const margin = 12;
    const width = parent.clientWidth;
    const height = parent.clientHeight;
    panel.style.maxWidth = `${Math.max(0, width - margin * 2)}px`;
    panel.style.maxHeight = `${Math.max(0, height - margin * 2)}px`;
    // Until the map has layout (e.g. detached/hidden), leave CSS to position it.
    if (!width || !height) return;
    const maxLeft = Math.max(margin, width - panel.offsetWidth - margin);
    const maxTop = Math.max(margin, height - panel.offsetHeight - margin);
    panel.style.left = `${Math.min(Math.max(margin, left ?? panel.offsetLeft), maxLeft)}px`;
    panel.style.top = `${Math.min(Math.max(margin, top ?? panel.offsetTop), maxTop)}px`;
    panel.style.right = 'auto';
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.drag = null;
  }
}
