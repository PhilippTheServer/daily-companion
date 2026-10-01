import { HttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideFeatureTesting, requests } from './http';

describe('requests', () => {
  it('keeps requests it matched on an earlier poll until the count is reached', async () => {
    TestBed.configureTestingModule({ providers: provideFeatureTesting() });
    const http = TestBed.inject(HttpClient);
    http.get('/api/v2/x').subscribe();
    setTimeout(() => http.get('/api/v2/x').subscribe(), 60);
    const found = await requests('/api/v2/x', 2);
    expect(found).toHaveLength(2);
  });
});
