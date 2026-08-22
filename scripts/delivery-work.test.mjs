#!/usr/bin/env node
// Focused contract tests for shared recipe progress, reservation, delivery, and restart behavior.

import assert from "node:assert/strict";
import {createDeliveryWork,deliveryComplete,deliveryNeed,deliveryStatus,deliverToWork,resetDeliveryWork} from "../src/game/delivery-work.js";

const work=createDeliveryWork({wood:2,stone:1});
assert.equal(deliveryNeed(work,"wood"),2);
assert.equal(deliveryNeed(work,"wood",1),1);
const cargo={wood:4,stone:0,dust:2,coin:0,diamond:0};
assert.deepEqual(deliverToWork(work,cargo),{accepted:{wood:2,stone:0,dust:0,coin:0,diamond:0},total:2,completed:false});
assert.deepEqual(cargo,{wood:2,stone:0,dust:2,coin:0,diamond:0},"unneeded cargo must remain caller-owned");
cargo.stone=1;
assert.equal(deliverToWork(work,cargo).completed,true);
assert.equal(deliveryComplete(work),true);
assert.deepEqual(deliveryStatus(work).delivered,{wood:2,stone:1,dust:0,coin:0,diamond:0});
resetDeliveryWork(work,{dust:5});
assert.equal(deliveryNeed(work,"dust"),5);
assert.deepEqual(deliveryStatus(work).delivered,{wood:0,stone:0,dust:0,coin:0,diamond:0});
assert.throws(()=>createDeliveryWork({}),/empty recipe/);
console.log("delivery work ok");
