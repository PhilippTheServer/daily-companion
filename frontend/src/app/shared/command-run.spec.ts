import { TestBed } from '@angular/core/testing';
import { CommandRun } from './command-run';

function make(explain?: (error: unknown) => string): CommandRun {
  return TestBed.runInInjectionContext(() => new CommandRun(explain));
}

describe('CommandRun', () => {
  it('ignores a second run while one is in flight', async () => {
    const command = make();
    let finish!: () => void;
    const send = vi.fn(
      () =>
        new Promise<{ warnings?: string[] }>((resolve) => {
          finish = () => resolve({});
        }),
    );
    const first = command.run('a', send);
    expect(command.busy()).toBe(true);
    expect(await command.run('a', send)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    finish();
    expect(await first).toBe(true);
    expect(command.busy()).toBe(false);
  });

  it('reuses the key after a failure and renews it after a success', async () => {
    const command = make();
    const keys: string[] = [];
    const send = (fail: boolean) => async (key: string) => {
      keys.push(key);
      if (fail) {
        throw new Error('down');
      }
      return {};
    };
    expect(await command.run('a', send(true))).toBe(false);
    expect(command.failure()).toBeTruthy();
    expect(await command.run('a', send(false))).toBe(true);
    expect(command.failure()).toBeNull();
    expect(await command.run('a', send(false))).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('uses a new key when the signature changes', async () => {
    const command = make();
    const keys: string[] = [];
    const fail = async (key: string) => {
      keys.push(key);
      throw new Error('down');
    };
    await command.run('a', fail);
    await command.run('b', fail);
    await command.run('b', fail);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
  });

  it('shows the explained failure and can clear it', async () => {
    const command = make(() => 'custom');
    await command.run('a', async () => {
      throw new Error('x');
    });
    expect(command.failure()).toBe('custom');
    command.clear();
    expect(command.failure()).toBeNull();
  });
});
