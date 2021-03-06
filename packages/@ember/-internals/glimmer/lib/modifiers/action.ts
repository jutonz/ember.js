import { uuid } from '@ember/-internals/utils';
import { ActionManager, isSimpleClick } from '@ember/-internals/views';
import { assert, deprecate } from '@ember/debug';
import { flaggedInstrument } from '@ember/instrumentation';
import { join } from '@ember/runloop';
import {
  CapturedNamedArguments,
  CapturedPositionalArguments,
  DynamicScope,
  ModifierManager,
  VMArguments,
} from '@glimmer/interfaces';
import { registerDestructor } from '@glimmer/runtime';
import { createUpdatableTag } from '@glimmer/validator';
import { SimpleElement } from '@simple-dom/interface';
import { INVOKE } from '../helpers/mut';

const MODIFIERS = ['alt', 'shift', 'meta', 'ctrl'];
const POINTER_EVENT_TYPE_REGEX = /^click|mouse|touch/;

function isAllowedEvent(event: Event, allowedKeys: any) {
  if (allowedKeys === null || allowedKeys === undefined) {
    if (POINTER_EVENT_TYPE_REGEX.test(event.type)) {
      return isSimpleClick(event);
    } else {
      allowedKeys = '';
    }
  }

  if (allowedKeys.indexOf('any') >= 0) {
    return true;
  }

  for (let i = 0; i < MODIFIERS.length; i++) {
    if (event[MODIFIERS[i] + 'Key'] && allowedKeys.indexOf(MODIFIERS[i]) === -1) {
      return false;
    }
  }

  return true;
}

export let ActionHelper = {
  // registeredActions is re-exported for compatibility with older plugins
  // that were using this undocumented API.
  registeredActions: ActionManager.registeredActions,

  registerAction(actionState: ActionState) {
    let { actionId } = actionState;

    ActionManager.registeredActions[actionId] = actionState;

    return actionId;
  },

  unregisterAction(actionState: ActionState) {
    let { actionId } = actionState;

    delete ActionManager.registeredActions[actionId];
  },
};

export class ActionState {
  public element: SimpleElement;
  public actionId: number;
  public actionName: any;
  public actionArgs: any;
  public namedArgs: CapturedNamedArguments;
  public positional: CapturedPositionalArguments;
  public implicitTarget: any;
  public dom: any;
  public eventName: any;
  public tag = createUpdatableTag();

  constructor(
    element: SimpleElement,
    actionId: number,
    actionArgs: any[],
    namedArgs: CapturedNamedArguments,
    positionalArgs: CapturedPositionalArguments,
    dom: any
  ) {
    this.element = element;
    this.actionId = actionId;
    this.actionArgs = actionArgs;
    this.namedArgs = namedArgs;
    this.positional = positionalArgs;
    this.dom = dom;
    this.eventName = this.getEventName();

    registerDestructor(this, () => ActionHelper.unregisterAction(this));
  }

  getEventName() {
    let onRef = this.namedArgs.on;

    return onRef !== undefined ? onRef.value() : 'click';
  }

  getActionArgs() {
    let result = new Array(this.actionArgs.length);

    for (let i = 0; i < this.actionArgs.length; i++) {
      result[i] = this.actionArgs[i].value();
    }

    return result;
  }

  getTarget() {
    let { implicitTarget, namedArgs } = this;
    let { target } = namedArgs;

    return target !== undefined ? target.value() : implicitTarget.value();
  }

  handler(event: Event): boolean {
    let { actionName, namedArgs } = this;
    let { bubbles, preventDefault, allowedKeys } = namedArgs;

    let bubblesVal = bubbles !== undefined ? bubbles.value() : undefined;
    let preventDefaultVal = preventDefault !== undefined ? preventDefault.value() : undefined;
    let allowedKeysVal = allowedKeys !== undefined ? allowedKeys.value() : undefined;

    let target = this.getTarget();

    let shouldBubble = bubblesVal !== false;

    if (!isAllowedEvent(event, allowedKeysVal)) {
      return true;
    }

    if (preventDefaultVal !== false) {
      event.preventDefault();
    }

    if (!shouldBubble) {
      event.stopPropagation();
    }

    join(() => {
      let args = this.getActionArgs();
      let payload = {
        args,
        target,
        name: null,
      };
      if (typeof actionName[INVOKE] === 'function') {
        flaggedInstrument('interaction.ember-action', payload, () => {
          actionName[INVOKE].apply(actionName, args);
        });
        return;
      }
      if (typeof actionName === 'function') {
        flaggedInstrument('interaction.ember-action', payload, () => {
          actionName.apply(target, args);
        });
        return;
      }
      payload.name = actionName;
      if (target.send) {
        flaggedInstrument('interaction.ember-action', payload, () => {
          target.send.apply(target, [actionName, ...args]);
        });
      } else {
        assert(
          `The action '${actionName}' did not exist on ${target}`,
          typeof target[actionName] === 'function'
        );
        flaggedInstrument('interaction.ember-action', payload, () => {
          target[actionName].apply(target, args);
        });
      }
    });

    return shouldBubble;
  }
}

// implements ModifierManager<Action>
export default class ActionModifierManager implements ModifierManager<ActionState, unknown> {
  create(
    element: SimpleElement,
    _state: unknown,
    args: VMArguments,
    _dynamicScope: DynamicScope,
    dom: any
  ) {
    let { named, positional } = args.capture();

    let actionArgs: any[] = [];
    // The first two arguments are (1) `this` and (2) the action name.
    // Everything else is a param.
    for (let i = 2; i < positional.length; i++) {
      actionArgs.push(positional[i]);
    }

    let actionId = uuid();
    let actionState = new ActionState(element, actionId, actionArgs, named, positional, dom);

    deprecate(
      `Using the \`{{action}}\` modifier with \`${actionState.eventName}\` events has been deprecated.`,
      actionState.eventName !== 'mouseEnter' &&
        actionState.eventName !== 'mouseLeave' &&
        actionState.eventName !== 'mouseMove',
      {
        id: 'ember-views.event-dispatcher.mouseenter-leave-move',
        until: '4.0.0',
        url: 'https://emberjs.com/deprecations/v3.x#toc_action-mouseenter-leave-move',
      }
    );

    return actionState;
  }

  getDebugName() {
    return 'action';
  }

  install(actionState: ActionState) {
    let { dom, element, actionId, positional } = actionState;

    let actionName;
    let actionNameRef: any;
    let implicitTarget;

    if (positional.length > 1) {
      implicitTarget = positional[0];
      actionNameRef = positional[1];

      if (actionNameRef[INVOKE]) {
        actionName = actionNameRef;
      } else {
        let actionLabel = actionNameRef.propertyKey;
        actionName = actionNameRef.value();

        assert(
          'You specified a quoteless path, `' +
            actionLabel +
            '`, to the ' +
            '{{action}} helper which did not resolve to an action name (a ' +
            'string). Perhaps you meant to use a quoted actionName? (e.g. ' +
            '{{action "' +
            actionLabel +
            '"}}).',
          typeof actionName === 'string' || typeof actionName === 'function'
        );
      }
    }

    actionState.actionName = actionName;
    actionState.implicitTarget = implicitTarget;

    ActionHelper.registerAction(actionState);

    dom.setAttribute(element, 'data-ember-action', '');
    dom.setAttribute(element, `data-ember-action-${actionId}`, actionId);
  }

  update(actionState: ActionState) {
    let { positional } = actionState;
    let actionNameRef = positional[1];

    if (!actionNameRef[INVOKE]) {
      actionState.actionName = actionNameRef.value();
    }

    actionState.eventName = actionState.getEventName();
  }

  getTag(actionState: ActionState) {
    return actionState.tag;
  }

  getDestroyable(actionState: ActionState) {
    return actionState;
  }
}
