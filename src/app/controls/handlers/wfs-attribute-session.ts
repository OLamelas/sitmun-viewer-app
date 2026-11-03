import { AttributeData, copyAttributeData } from '../../utils/feature-attribute-draft';

interface AttributeAction {
  type: string;
  oldData: AttributeData;
  newData: AttributeData;
}

export interface AttributeSessionFeature {
  layer: unknown;
  getData(): AttributeData;
}

export interface AttributeSessionEdit {
  history: EventTarget & {
    setData(feature: AttributeSessionFeature, data: AttributeData): AttributeAction;
  };
  trigger(type: string, event: Record<string, unknown>): unknown;
}

export const ATTRIBUTE_MODIFY_EVENT = 'featuremodify.tc';

export class AttributeRegistrationFailure extends Error {
  constructor(cause: unknown, readonly retry: () => Promise<void>) {
    super(cause instanceof Error ? cause.message : 'registrationFailed', { cause });
  }
}

function registerAttributeAction(
  edit: AttributeSessionEdit,
  feature: AttributeSessionFeature,
  action: AttributeAction
): Promise<void> {
  let registration: Promise<unknown> | undefined;
  edit.trigger(ATTRIBUTE_MODIFY_EVENT, {
    feature, layer: feature.layer, oldData: action.oldData, newData: action.newData,
    geometryChanged: false,
    sitmunRegister: (operation: Promise<unknown>) => { registration = operation; }
  });
  if (!registration) return Promise.reject(new Error('registrationUnavailable'));
  return registration.then(() => undefined).catch((error: unknown) => {
    throw new AttributeRegistrationFailure(error, () => registerAttributeAction(edit, feature, action));
  });
}

/** Uses the existing WFSEdit listener, whose patched callback acknowledges storage. */
export async function applyNativeAttributeData(
  edit: AttributeSessionEdit,
  feature: AttributeSessionFeature,
  data: AttributeData
): Promise<boolean> {
  const current = copyAttributeData(feature.getData());
  const next = copyAttributeData(data);
  if (JSON.stringify(current) === JSON.stringify(next)) return false;
  const action = edit.history.setData(feature, next);
  // Failure keeps the form draft recoverable; do not pretend the in-memory
  // history mutation was rolled back or issue a second history action.
  await registerAttributeAction(edit, feature, action);
  return true;
}

/** Attribute undo/redo does not emit FEATUREMODIFY in SITNA 4.9.1. */
export function connectNativeAttributeHistory(
  edit: AttributeSessionEdit,
  registered: (feature: AttributeSessionFeature, error?: unknown) => void,
  registering: (pending: boolean) => void = () => undefined
): () => void {
  const cleanups = (['undo', 'redo'] as const).map((type) => {
    const listener = (event: Event) => {
      const { feature, action } = event as Event & {
        feature: AttributeSessionFeature;
        action: AttributeAction;
      };
      if (action.type !== 'attributesChange') return;
      registering(true);
      let registration: Promise<unknown> | undefined;
      edit.trigger(ATTRIBUTE_MODIFY_EVENT, {
        feature, layer: feature.layer, geometryChanged: false, historyAction: type,
        oldData: type === 'undo' ? action.newData : action.oldData,
        newData: type === 'undo' ? action.oldData : action.newData,
        sitmunRegister: (operation: Promise<unknown>) => { registration = operation; }
      });
      if (!registration) {
        registered(feature, new Error('registrationUnavailable'));
        registering(false);
        return;
      }
      void registration.then(() => registered(feature), (error: unknown) => registered(feature,
        new AttributeRegistrationFailure(error, () => registerAttributeAction(edit, feature, {
          ...action,
          oldData: type === 'undo' ? action.newData : action.oldData,
          newData: type === 'undo' ? action.oldData : action.newData
        })))).finally(() => registering(false));
    };
    edit.history.addEventListener(type, listener);
    return () => edit.history.removeEventListener(type, listener);
  });
  return () => cleanups.forEach((cleanup) => cleanup());
}
