import {reviewEligibility} from './review-scheduler.mjs';
import {executionEligibility} from './execution-scheduler.mjs';
import {coordinatorEligibility} from './coordinator-scheduler.mjs';

export function deliveryEligibility(state,job) {
  const review=reviewEligibility(state,job);
  if(review!=='unmanaged')return review;
  const execution=executionEligibility(state,job);
  return execution==='unmanaged'?coordinatorEligibility(state,job):execution;
}
