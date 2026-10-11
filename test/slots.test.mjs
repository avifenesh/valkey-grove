import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {hashSlot,ownerOf} from '../dist/slots.js';
test('CRC16 XMODEM published check vector',()=>assert.equal(hashSlot('123456789'),0x31c3));
test('hash tags and empty braces follow Valkey semantics',()=>{
 assert.equal(hashSlot('user:{42}:profile'),hashSlot('cart:{42}'));
 assert.equal(hashSlot('{foo}{bar}'),hashSlot('foo'));
 assert.equal(hashSlot('foo{}{bar}'),8363);
});
test('slot owner respects disjoint and unassigned ranges',()=>{
 const nodes=[{slots:[[0,20],[100,200]]},{slots:[[21,99]]}];
 assert.equal(ownerOf(150,nodes),0);assert.equal(ownerOf(80,nodes),1);assert.equal(ownerOf(201,nodes),-1);
});
test('Unicode, braces and edge cases agree with a real Valkey cluster',{skip:!process.env.GROVE_TEST_PORT},()=>{
 for(const key of ['123456789','user:2048:profile','user:{42}:profile','cart:{42}','foo{}{bar}','{{a}}','{foo}{bar}','plain','a{','🌱:שלום','']){
 const actual=Number(execFileSync('valkey-cli',['-p',process.env.GROVE_TEST_PORT,'CLUSTER','KEYSLOT',key],{encoding:'utf8'}).trim());assert.equal(hashSlot(key),actual,key);
 }
});
