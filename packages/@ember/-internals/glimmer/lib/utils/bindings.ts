import { get } from '@ember/-internals/metal';
import { assert, deprecate } from '@ember/debug';
import { EMBER_COMPONENT_IS_VISIBLE } from '@ember/deprecated-features';
import { dasherize } from '@ember/string';
import { DEBUG } from '@glimmer/env';
import { ElementOperations, Option } from '@glimmer/interfaces';
import { CachedReference, PathReference, Reference, RootReference } from '@glimmer/reference';
import { PrimitiveReference, UNDEFINED_REFERENCE } from '@glimmer/runtime';
import { logTrackingStack } from '@glimmer/validator';
import { SimpleElement } from '@simple-dom/interface';
import { Component } from './curly-component-state-bucket';
import { referenceFromParts } from './references';
import { htmlSafe, isHTMLSafe, SafeString } from './string';

export function referenceForKey(rootRef: RootReference<Component>, key: string) {
  return rootRef.get(key);
}

function referenceForParts(rootRef: RootReference<Component>, parts: string[]): Reference {
  let isAttrs = parts[0] === 'attrs';

  // TODO deprecate this
  if (isAttrs) {
    parts.shift();

    if (parts.length === 1) {
      return referenceForKey(rootRef, parts[0]);
    }
  }

  return referenceFromParts(rootRef, parts);
}

export const AttributeBinding = {
  parse(microsyntax: string): [string, string, boolean] {
    let colonIndex = microsyntax.indexOf(':');

    if (colonIndex === -1) {
      assert(
        'You cannot use class as an attributeBinding, use classNameBindings instead.',
        microsyntax !== 'class'
      );
      return [microsyntax, microsyntax, true];
    } else {
      let prop = microsyntax.substring(0, colonIndex);
      let attribute = microsyntax.substring(colonIndex + 1);

      assert(
        'You cannot use class as an attributeBinding, use classNameBindings instead.',
        attribute !== 'class'
      );

      return [prop, attribute, false];
    }
  },

  install(
    component: Component,
    rootRef: RootReference<Component>,
    parsed: [string, string, boolean],
    operations: ElementOperations
  ) {
    let [prop, attribute, isSimple] = parsed;

    if (attribute === 'id') {
      let elementId = get(component, prop);
      if (elementId === undefined || elementId === null) {
        elementId = component.elementId;
      }
      elementId = PrimitiveReference.create(elementId);
      operations.setAttribute('id', elementId, true, null);
      // operations.addStaticAttribute(element, 'id', elementId);
      return;
    }

    let isPath = prop.indexOf('.') > -1;
    let reference = isPath
      ? referenceForParts(rootRef, prop.split('.'))
      : referenceForKey(rootRef, prop);

    assert(
      `Illegal attributeBinding: '${prop}' is not a valid attribute name.`,
      !(isSimple && isPath)
    );

    if (
      EMBER_COMPONENT_IS_VISIBLE &&
      attribute === 'style' &&
      StyleBindingReference !== undefined
    ) {
      reference = new StyleBindingReference(
        rootRef,
        reference,
        referenceForKey(rootRef, 'isVisible')
      );
    }

    operations.setAttribute(attribute, reference, false, null);
    // operations.addDynamicAttribute(element, attribute, reference, false);
  },
};

const DISPLAY_NONE = 'display: none;';
const SAFE_DISPLAY_NONE = htmlSafe(DISPLAY_NONE);

let StyleBindingReference:
  | undefined
  | {
      new (
        parent: PathReference<Component>,
        inner: Reference<unknown>,
        isVisible: Reference<unknown>
      ): Reference<string | SafeString>;
    };

export let installIsVisibleBinding:
  | undefined
  | ((rootRef: RootReference<Component>, operations: ElementOperations) => void);

if (EMBER_COMPONENT_IS_VISIBLE) {
  StyleBindingReference = class extends CachedReference<string | SafeString> {
    debugLabel?: string;

    constructor(
      parent: PathReference<Component>,
      private inner: Reference<unknown>,
      private isVisible: Reference<unknown>
    ) {
      super();

      if (DEBUG) {
        this.debugLabel = `${parent.debugLabel}.style`;
      }
    }

    compute(): string | SafeString {
      let value = this.inner.value();
      let isVisible = this.isVisible.value();

      if (DEBUG && isVisible !== undefined) {
        deprecate(
          `The \`isVisible\` property on classic component classes is deprecated. Was accessed:\n\n${logTrackingStack!()}`,
          false,
          {
            id: 'ember-component.is-visible',
            until: '4.0.0',
            url: 'https://deprecations.emberjs.com/v3.x#toc_ember-component-is-visible',
          }
        );
      }

      if (isVisible !== false) {
        return value as string;
      } else if (!value) {
        return SAFE_DISPLAY_NONE;
      } else {
        let style = value + ' ' + DISPLAY_NONE;
        return isHTMLSafe(value) ? htmlSafe(style) : style;
      }
    }

    get() {
      return UNDEFINED_REFERENCE;
    }
  };

  installIsVisibleBinding = (rootRef: RootReference<Component>, operations: ElementOperations) => {
    operations.setAttribute(
      'style',
      new StyleBindingReference!(rootRef, UNDEFINED_REFERENCE, rootRef.get('isVisible')),
      false,
      null
    );
  };
}

export const ClassNameBinding = {
  install(
    _element: SimpleElement,
    rootRef: RootReference<Component>,
    microsyntax: string,
    operations: ElementOperations
  ) {
    let [prop, truthy, falsy] = microsyntax.split(':');
    let isStatic = prop === '';

    if (isStatic) {
      operations.setAttribute('class', PrimitiveReference.create(truthy), true, null);
    } else {
      let isPath = prop.indexOf('.') > -1;
      let parts = isPath ? prop.split('.') : [];
      let value = isPath ? referenceForParts(rootRef, parts) : referenceForKey(rootRef, prop);
      let ref;

      if (truthy === undefined) {
        ref = new SimpleClassNameBindingReference(value, isPath ? parts[parts.length - 1] : prop);
      } else {
        ref = new ColonClassNameBindingReference(value, truthy, falsy);
      }

      operations.setAttribute('class', ref, false, null);
    }
  },
};

export class SimpleClassNameBindingReference implements Reference<Option<string>> {
  private dasherizedPath: Option<string> = null;

  constructor(private inner: Reference<unknown | number>, private path: string) {}

  isConst() {
    return this.inner.isConst();
  }

  value(): Option<string> {
    let value = this.inner.value();

    if (value === true) {
      let { path, dasherizedPath } = this;
      return dasherizedPath || (this.dasherizedPath = dasherize(path));
    } else if (value || value === 0) {
      return String(value);
    } else {
      return null;
    }
  }
}

class ColonClassNameBindingReference implements Reference<Option<string>> {
  constructor(
    private inner: Reference<unknown>,
    private truthy: Option<string> = null,
    private falsy: Option<string> = null
  ) {}

  isConst() {
    return this.inner.isConst();
  }

  value(): Option<string> {
    let { inner, truthy, falsy } = this;
    return inner.value() ? truthy : falsy;
  }
}
