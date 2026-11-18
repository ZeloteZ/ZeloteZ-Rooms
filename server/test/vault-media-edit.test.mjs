import assert from 'node:assert/strict'
import test from 'node:test'
import { editedFileName, vaultFileKind, mediaDuration, playbackPosition } from '../../web/vault-media-edit.js'

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
