import assert from 'node:assert/strict'
import test from 'node:test'
import { createVaultPlayback, editedFileName, formatMediaTime, vaultFileKind, mediaDuration, playbackPosition } from '../../web/vault-media-edit.js'

test('very long valid suffixes produce bounded edited names without looping', () => {
 const result=editedFileName('x.'+'a'.repeat(253))
 assert.ok(new TextEncoder().encode(result).byteLength<=240)
 assert.ok(result.length>0)
})

test('passive media MIME disambiguates WebM while HTML and SVG stay source text', () => {
 assert.equal(vaultFileKind({name:'audio.webm',type:'audio/webm;codecs=opus'}),'audio')
 assert.equal(vaultFileKind({name:'video.ogg',type:'video/ogg'}),'video')
 assert.equal(vaultFileKind({name:'not-a-movie.svg',type:'video/mp4'}),'text')
 assert.equal(vaultFileKind({name:'page.html',type:'image/png'}),'text')
})

test('player positions remain inside a finite duration', () => {
 assert.equal(playbackPosition(12,50),12)
 assert.equal(playbackPosition(12,-2),0)
 assert.equal(playbackPosition(12,3.5),3.5)
})

test('already-known media durations do not seek or mutate playback', async () => {
 const media={duration:12,currentTime:3}
 assert.equal(await mediaDuration(media),12)
 assert.equal(media.currentTime,3)
})

class PlayerMedia extends EventTarget {
 constructor(){super();this.paused=true;this.ended=false;this.currentTime=1;this.duration=10;this.volume=1;this.muted=false;this.playbackRate=1;this.src='blob:private-player';this.loads=0;this.listeners=new Map()}
 addEventListener(name,callback,options){super.addEventListener(name,callback,options);if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(callback)}
 removeEventListener(name,callback,options){super.removeEventListener(name,callback,options);this.listeners.get(name)?.delete(callback)}
 play(){return new Promise(resolve=>{this.finishPlaying=()=>{this.paused=false;this.dispatchEvent(new Event('playing'));resolve()}})}
 pause(){this.paused=true;this.dispatchEvent(new Event('pause'))}
 removeAttribute(name){if(name==='src')this.src=''}
 load(){this.loads++}
}

test('aborted player ignores a late play resolution and clears media sources and event listeners', async t=>{
 const media=new PlayerMedia(),controller=new AbortController();let changes=0,errors=0
 const player=createVaultPlayback(media,{signal:controller.signal,onState(){changes++},onError(){errors++}})
 const playing=player.toggle()
 t.after(()=>{media.finishPlaying?.();player.dispose()})
 controller.abort();const afterAbort=changes
 assert.equal(media.paused,true);assert.equal(media.src,'');assert.equal(media.loads,1)
 assert.ok([...media.listeners.values()].every(listeners=>listeners.size===0))
 media.finishPlaying();await playing;await Promise.resolve()
 assert.equal(media.paused,true);assert.equal(changes,afterAbort);assert.equal(errors,0)
 media.dispatchEvent(new Event('timeupdate'));assert.equal(changes,afterAbort)
 player.dispose();assert.equal(media.loads,1)
})

test('player controls bound seek, volume and rates and become inert after disposal',()=>{
 const media=new PlayerMedia(),player=createVaultPlayback(media)
 player.seek(999);assert.equal(media.currentTime,10)
 player.seek(-5);assert.equal(media.currentTime,0)
 player.seek(NaN);assert.equal(media.currentTime,0)
 player.volume(-1);assert.equal(media.volume,0);assert.equal(media.muted,true)
 player.volume(2);assert.equal(media.volume,1);assert.equal(media.muted,false)
 player.volume(NaN);assert.equal(media.volume,1)
 player.rate(1.5);assert.equal(media.playbackRate,1.5)
 for(const value of [0,20,NaN,Infinity])player.rate(value)
 assert.equal(media.playbackRate,1.5)
 player.mute();assert.equal(media.muted,true)
 assert.equal(formatMediaTime(3601),'1:00:01');assert.equal(formatMediaTime(Infinity),'--:--')
 player.dispose();player.seek(4);player.volume(.3);player.rate(.5);player.mute()
 assert.equal(media.currentTime,0);assert.equal(media.volume,1);assert.equal(media.playbackRate,1.5);assert.equal(media.muted,true)
 assert.equal(media.src,'');assert.ok([...media.listeners.values()].every(listeners=>listeners.size===0))
})
