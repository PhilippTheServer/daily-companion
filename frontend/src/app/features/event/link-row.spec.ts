import { TestBed } from '@angular/core/testing';
import { event } from '../../../testing/events';
import { provideFeatureTesting, request } from '../../../testing/http';
import { Api } from '../../core/api/api';
import type { LinkOut } from '../../core/api/types';
import { LinkRow } from './link-row';

describe('LinkRow', () => {
  function open(link: LinkOut) {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const fixture = TestBed.createComponent(LinkRow);
    fixture.componentRef.setInput('link', link);
    return { fixture, element: fixture.nativeElement as HTMLElement };
  }

  const other = {
    chain_id: 'c-b',
    kind: 'intake',
    versions: [
      event({ kind: 'intake', chain_id: 'c-b', payload: { slot: 'breakfast', items: [] } }),
    ],
    links: [],
  };

  it('shows the error instead of an ellipsis when the load fails', async () => {
    const { element } = open({ chain_id: 'c-b', relation: 'follows', direction: 'outgoing' });
    (await request('/api/v2/views/event')).flush(
      { code: 'not_found', message: 'gone', field: null },
      { status: 404, statusText: 'Not Found' },
    );
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('gone');
    });
    expect(element.textContent).not.toContain('…');
  });

  it('labels the unlink button with the other event', async () => {
    const { element } = open({ chain_id: 'c-b', relation: 'follows', direction: 'outgoing' });
    (await request('/api/v2/views/event')).flush(other);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('button')!.getAttribute('aria-label')).toMatch(
        /^Unlink Breakfast/,
      );
    });
  });

  it('reloads the other event after a command revision', async () => {
    const { element } = open({ chain_id: 'c-b', relation: 'follows', direction: 'outgoing' });
    (await request('/api/v2/views/event')).flush(other);
    await vi.waitFor(() => {
      TestBed.tick();
      expect(element.querySelector('button')!.getAttribute('aria-label')).toMatch(/Breakfast/);
    });
    TestBed.inject(Api).revision.update((n) => n + 1);
    const again = await request('/api/v2/views/event');
    again.flush(other);
    expect(again.request.params.get('chain_id')).toBe('c-b');
  });

  it.each([
    ['suspected_cause', 'outgoing', 'Suspected cause:'],
    ['suspected_cause', 'incoming', 'Suspected cause of:'],
    ['part_of', 'outgoing', 'Part of:'],
    ['part_of', 'incoming', 'Has part:'],
    ['follows', 'outgoing', 'Follows:'],
    ['follows', 'incoming', 'Followed by:'],
  ] as const)('words %s %s as "%s"', (relation, direction, label) => {
    const { element } = open({ chain_id: 'c-b', relation, direction });
    TestBed.tick();
    expect(element.querySelector('.relation')!.textContent).toBe(label);
  });
});
