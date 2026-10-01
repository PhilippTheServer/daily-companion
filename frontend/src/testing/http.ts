import { HttpRequest, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { EnvironmentProviders, Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideTestConfig } from './config';

type Match = string | ((request: HttpRequest<unknown>) => boolean);

/** Config, router and a testing HttpClient: what every feature spec needs. */
export function provideFeatureTesting(): (Provider | EnvironmentProviders)[] {
  return [provideTestConfig(), provideRouter([]), provideHttpClient(), provideHttpClientTesting()];
}

/**
 * Run change detection until the app has sent `count` requests matching `match` (a URL path
 * or a predicate), then return them. Never await fixture.whenStable() while a request is
 * open: the app is not stable until it ends.
 */
export async function requests(match: Match, count: number): Promise<TestRequest[]> {
  const backend = TestBed.inject(HttpTestingController);
  const predicate =
    typeof match === 'string' ? (r: HttpRequest<unknown>) => r.url === match : match;
  const found: TestRequest[] = [];
  return vi.waitFor(() => {
    TestBed.tick();
    found.push(...backend.match(predicate));
    if (found.length !== count) {
      throw new Error(`expected ${count} request(s), saw ${found.length}`);
    }
    return found;
  });
}

/** The one request matching `match`, once the app has sent it. */
export async function request(match: Match): Promise<TestRequest> {
  return (await requests(match, 1))[0];
}
