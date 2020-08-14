import { assert } from '@ember/debug';
import { DEBUG } from '@glimmer/env';
import { Helper, VMArguments } from '@glimmer/interfaces';
import { createComputeRef, valueForRef } from '@glimmer/reference';

let helper: Helper;

if (DEBUG) {
  helper = (args: VMArguments) => {
    let inner = args.positional.at(0);

    return createComputeRef(() => {
      let value = valueForRef(inner);

      assert(valueForRef(args.positional.at(1)) as string, typeof value !== 'string');

      return value;
    });
  };
} else {
  helper = (args: VMArguments) => args.positional.at(0);
}

export default helper;
