# Rocket.Chat end-to-end encryption, as implemented by the 8.9.0 client

This document describes the E2EE formats and flows of Rocket.Chat **8.9.0** precisely enough to write an
independent decryptor. It describes what the code does, not what the product documentation says. Where the two
disagree, see [Discrepancies with public docs](#11-discrepancies-with-public-docs).

- Every statement is taken from the Rocket.Chat source at tag `8.9.0` and cited as `file:line`.
- Statements marked **observed** come from the artifacts the real web client produced in
  `test/fixtures/8.9.0` (see [How this is verified](#13-how-this-is-verified)).
- WebCrypto behaviour that the client relies on implicitly (GCM tag size, CBC padding) is called out as such.

rc-mcp's implementation lives in `src/e2ee/` (decrypt side only). Each section names the module that ports it.

## Contents

1. [Sources](#1-sources)
2. [The key chain](#2-the-key-chain)
3. [Encodings](#3-encodings)
4. [Password and key derivation](#4-password-and-key-derivation)
5. [Stored private key (v1, v2)](#5-stored-private-key-v1-v2)
6. [Room keys](#6-room-keys)
7. [Message content](#7-message-content)
8. [Key distribution, suggested keys and room key reset](#8-key-distribution-suggested-keys-and-room-key-reset)
9. [File encryption](#9-file-encryption)
10. [Deletion semantics](#10-deletion-semantics)
11. [Discrepancies with public docs](#11-discrepancies-with-public-docs)
12. [Version history](#12-version-history)
13. [How this is verified](#13-how-this-is-verified)
14. [What rc-mcp supports](#14-what-rc-mcp-supports)

## 1. Sources

All paths are relative to the root of the Rocket.Chat repository at tag `8.9.0`. In the dev setup it is cloned
into `.local/rocket.chat`.

| Short name | Path |
| --- | --- |
| `binary.ts`, `codec.ts`, `content.ts`, `helper.ts`, `keychain.ts`, `prefixed.ts` | `apps/meteor/client/lib/e2ee/` |
| `rocketchat.e2e.ts`, `rocketchat.e2e.room.ts` | `apps/meteor/client/lib/e2ee/` |
| `aes.ts`, `pbkdf2.ts`, `rsa.ts` | `apps/meteor/client/lib/e2ee/crypto/` |
| `uploadFiles.ts`, `processMessageUploads.ts` | `apps/meteor/client/lib/chats/flows/` |
| `uploads.ts`, `data.ts` | `apps/meteor/client/lib/chats/` |
| `prependReplies.ts` | `apps/meteor/client/lib/utils/prependReplies.ts` |
| `useE2EEncryption.ts` | `apps/meteor/client/views/root/hooks/loggedIn/useE2EEncryption.ts` |
| `useE2EERoomAction.ts` | `apps/meteor/client/hooks/roomActions/useE2EERoomAction.ts` |
| `useE2EEResetRoomKey.ts` | `apps/meteor/client/views/room/hooks/useE2EEResetRoomKey.ts` |
| `enc.js` | `apps/meteor/public/enc.js` (service worker that decrypts downloads) |
| `resetRoomKey.ts`, `handleSuggestedGroupKey.ts`, `provideUsersSuggestedGroupKeys.ts` | `apps/meteor/server/lib/e2e/functions/` |
| `api/v1/e2e.ts`, `api/v1/rooms.ts`, `api/v1/chat.ts` | `apps/meteor/server/api/v1/` |
| `resetUserE2EKey.ts` | `apps/meteor/server/lib/resetUserE2EKey.ts` |
| `FileUpload.ts` | `apps/meteor/server/lib/media/file-upload/lib/FileUpload.ts` |
| `deleteMessage.ts`, `updateMessage.ts` | `apps/meteor/server/lib/messages/` |
| `publications/messages.ts` | `apps/meteor/server/publications/messages.ts` |
| `settings/e2e.ts` | `apps/meteor/server/settings/e2e.ts` |
| `IMessage.ts` | `packages/core-typings/src/IMessage/IMessage.ts` |
| `ISubscription.ts`, `IUpload.ts` | `packages/core-typings/src/` |
| `Messages.ts`, `Subscriptions.ts`, `Users.ts`, `BaseRaw.ts`, `Trash.ts` | `packages/models/src/models/` |
| `base64.ts` | `packages/base64/src/base64.ts` |

## 2. The key chain

```
E2EE password  (user-chosen, or the generated 12-word passphrase)
  │  PBKDF2-HMAC-SHA-256 over Latin-1 bytes, 256 bits                      §4
  ▼
master key  (AES-CBC-256 for v1 backups, AES-GCM-256 for v2)               client memory only
  │  decrypts users.e2e.private_key  (GET /api/v1/e2e.fetchMyKeys)        §5
  ▼
RSA-OAEP-2048 / SHA-256 private key  (JWK)                                  one per user
  │  unwraps subscription E2EKey | E2ESuggestedKey | oldRoomKeys[].E2EKey  §6
  ▼
room key  (JWK: A256GCM; legacy A128CBC)                                    one per room key id
  │  decrypts message.content | legacy message.msg | upload.content        §7
  ▼
EJSON plaintext  {msg, attachments?, files?, file?}
  │  each encrypted file attachment carries its own key                    §9
  ▼
file key  (AES-CTR-256 JWK + 16-byte initial counter block)                 one per upload
  │  decrypts the bytes at /file-upload/<id>/<sha256hex(original name)>
  ▼
file plaintext  (its SHA-256 is recorded in attachment hashes.sha256)
```

## 3. Encodings

| Name | Definition | Used for |
| --- | --- | --- |
| Base64 | Standard alphabet `A-Z a-z 0-9 + /` with `=` padding (`base64.ts:3`, `66-72`) | IVs, ciphertexts, wrapped keys, `$binary` |
| Binary string | `Binary.decode` turns each UTF-16 code unit into one byte and throws `RangeError('illegal char code')` above `0xFF` (`binary.ts:14-31`). `Binary.encode` turns each byte into one char (`binary.ts:4-13`). | Password, PBKDF2 salt, private-key JWK string, room-key JWK string |
| UTF-8 | `TextEncoder` before encryption (`rocketchat.e2e.room.ts:666`), `TextDecoder` after decryption (`aes.ts:54`). The decoder is the non-fatal default: invalid sequences become U+FFFD instead of failing. | Message and upload plaintext |
| EJSON | Meteor `ejson` package, `EJSON.stringify` / `EJSON.parse` (`rocketchat.e2e.room.ts:15`, `666`, `783`). Dates become `{"$date": <ms>}`. | Message and upload plaintext |
| JSON | `JSON.stringify` / `JSON.parse` | Keys (stored private key, JWKs) |

rc-mcp: `src/e2ee/encoding.ts` (`binaryStringToBytes` = `Binary.decode`; its base64 decoding is strict),
`src/e2ee/ejson.ts` (read-only EJSON) and `src/e2ee/content.ts` (non-fatal UTF-8 decoding, like the client).

## 4. Password and key derivation

`Keychain.decryptKey` (`keychain.ts:139-150`):

1. Decode the stored key into `{iv, ciphertext}` plus `{salt, iterations}` (§5).
2. Choose the cipher by IV length: 16 bytes means `AES-CBC`, anything else means `AES-GCM` (`keychain.ts:141`).
3. Import `Binary.decode(password)` as a raw `PBKDF2` key (`keychain.ts:142`, `pbkdf2.ts:35-38`).
4. Run `deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt: Binary.decode(salt), iterations}, 256)`
   (`keychain.ts:143-146`, `pbkdf2.ts:55-62`).
5. Import the 32 bytes as `{name: <cipher>, length: 256}` (`keychain.ts:147`, `pbkdf2.ts:64-68`).
6. Decrypt (`pbkdf2.ts:70-77`). `Binary.encode` of the result is the private-key JWK string (`keychain.ts:149`).
   `loadKeys` later parses it with `JSON.parse` (`rocketchat.e2e.ts:468`).

| Parameter | v1 backup | v2 backup |
| --- | --- | --- |
| KDF | PBKDF2-HMAC-SHA-256 | PBKDF2-HMAC-SHA-256 |
| Output | 256 bits | 256 bits |
| Salt | the user id, e.g. `B3mFABPgFaLqcu9Tt` (`keychain.ts:108`) | the stored `salt` string, `v2:<userId>:<random UUID>` (`keychain.ts:153`) |
| Iterations | 1000 (`keychain.ts:109`) | the stored `iterations`; the client writes 100000 (`keychain.ts:154`) |
| Cipher | AES-CBC-256, 16-byte IV | AES-GCM-256, 12-byte IV (`pbkdf2.ts:84`) |

**The password is not UTF-8 encoded.** Each UTF-16 code unit becomes one byte, which is Latin-1 for
characters up to U+00FF. For example, `é` (U+00E9) becomes the single byte `0xE9`. A password containing
any character above U+00FF (`€`, CJK, emoji, ...) makes `Binary.decode` throw. Such a password cannot unlock
the key in the official client either. rc-mcp reports this as `unsupported-password`.

The generated passphrase is 12 words chosen uniformly by rejection sampling from the 2048-word BIP-39 English
list (`helper.ts:17-41`, `wordList.ts`), separated by single spaces. It is therefore pure ASCII.

The `v2:` prefix of the salt is never parsed. The whole string is the PBKDF2 salt.

## 5. Stored private key (v1, v2)

`GET /api/v1/e2e.fetchMyKeys` (`api/v1/e2e.ts:219`) returns:

```json
{ "public_key": "<JSON string>", "private_key": "<JSON string>", "success": true }
```

Both values are JSON **strings**. The server stores what the client posted. The client sends
`private_key: JSON.stringify(encodedPrivateKey)` to `POST e2e.setUserPublicAndPrivateKeys`
(`rocketchat.e2e.ts:279-299`).

The client detects the format by its fields. It checks `$binary` first, then the four v2 fields
(`keychain.ts:38-64`).

**v1** (written by clients before 7.13.0, still decrypted by 8.9.0, `keychain.ts:9-21`, `101-111`):

```json
{"$binary":"<base64( iv[16] ‖ AES-CBC-256 ciphertext )>"}
```

**v2** (written by 7.13.0 and later, `keychain.ts:22-33`, `152-162`):

```json
{"iv":"<base64 of 12 bytes>","ciphertext":"<base64( AES-GCM ciphertext ‖ 16-byte tag )>","salt":"v2:<userId>:<uuid>","iterations":100000}
```

The 16-byte tag comes from WebCrypto's AES-GCM default (`tagLength` 128). No additional data is used.

A v1 backup is rewritten as v2 only when the key pair is persisted again. `persistKeys` always calls
`encryptKey`, which writes v2 (`rocketchat.e2e.ts:279-299`, `435-441`).

**Observed:** all three 8.9.0 fixture users have v2 backups with `iterations: 100000` and salts of the form
`v2:<userId>:<uuid>`.

**Decrypted private key**: the RSA private key as a JWK JSON string (`rsa.ts:46-59`). Member order is not
significant.

```json
{"alg":"RSA-OAEP-256","d":"…","dp":"…","dq":"…","e":"AQAB","ext":true,"key_ops":["decrypt"],"kty":"RSA","n":"…","p":"…","q":"…","qi":"…"}
```

**Public key** (`public_key`, `rsa.ts:37-44`, **observed**):

```json
{"alg":"RSA-OAEP-256","e":"AQAB","ext":true,"key_ops":["encrypt"],"kty":"RSA","n":"…"}
```

The key pair is generated as `RSA-OAEP`, modulus length 2048, public exponent 65537, hash SHA-256
(`rsa.ts:20-33`). It is imported the same way (`rsa.ts:71-99`).

With AES-CBC, a wrong password can still produce valid padding by chance. rc-mcp therefore also checks that the
decrypted JWK parses and that its `n` equals `n` of `public_key`. Any failure is reported as `wrong-password`.
(`src/e2ee/private-key.ts`, `src/e2ee/session.ts`)

## 6. Room keys

### 6.1 Room key JWK

```json
{"alg":"A256GCM","ext":true,"k":"<base64url of 32 bytes>","key_ops":["encrypt","decrypt"],"kty":"oct"}
```

The type is `aes.ts:23-29`. Since 7.13.0, new keys are `AES-GCM` 256-bit (`aes.ts:44-46`).

| JWK `alg` | WebCrypto algorithm | IV length on encrypt | Source |
| --- | --- | --- | --- |
| `A256GCM` | AES-GCM, 256 bit | 12 bytes | `aes.ts:9`, `aes.ts:58` |
| `A128CBC` | AES-CBC, 128 bit (legacy room keys) | 16 bytes | `aes.ts:10`, `aes.ts:58` |

**Only the JWK `alg` selects the cipher** (`aes.ts:36-38`). The message's `content.algorithm` label does not.

### 6.2 Wrapped room key layout

A room key is distributed wrapped with each member's RSA public key:

```
<key id prefix, any length><base64( RSA-OAEP-SHA-256( Binary.decode( JSON.stringify(roomKeyJwk) ) ) )>
                           └────────────── always 344 characters = 256 bytes ──────────────┘
```

- **Parsing** (`PrefixedBase64.decode`, `prefixed.ts:18-37`): the prefix is `s.slice(0, -344)`, and the last 344
  characters must decode to exactly 256 bytes.
- **Encoding** (`prefixed.ts:38-54`): the key id is the prefix (`rocketchat.e2e.room.ts:599`, `577`).
- **Length**: a UUID key id (36 chars) gives a 380-character string (**observed**). A legacy 12-character id gives
  356 characters (upstream legacy vector).
- **Where it is stored** (`ISubscription.ts:7`, `46-47`, `78-79`):
  - `E2EKey`: the accepted current key.
  - `E2ESuggestedKey`: a key offered by another member that this user's client has not yet accepted.
  - `oldRoomKeys[].E2EKey` and `suggestedOldRoomKeys[].E2EKey`: keys from before room-key resets. Each entry is
    `{e2eKeyId, ts, E2EKey}`.
- **Unwrapping**: `importGroupKey` (`rocketchat.e2e.room.ts:387-428`) for the current or suggested key, and
  `decryptSessionKey` / `exportSessionKey` (`rocketchat.e2e.room.ts:367-385`) for old keys.

rc-mcp: `src/e2ee/room-key.ts` (`splitWrappedRoomKey`, `unwrapRoomKey`).

### 6.3 Key id (`kid`)

The key id names a room key. Messages reference it, and `room.e2eKeyId` holds the room's current one.

| Clients | How a new room key's id is made | Length |
| --- | --- | --- |
| 0.70.0 – 6.13.x | First 12 chars of `base64(JSON.stringify(jwk))`, in practice always `eyJhbGciOiJB` | 12 |
| 7.0.0 – 7.12.x (PR #33329) | First 12 hex chars of SHA-256 of `JSON.stringify(jwk)` | 12 |
| 7.13.0+ (PR #36942) | `crypto.randomUUID()` (`rocketchat.e2e.room.ts:434`) | 36 |

In 8.9.0 the room's key id is set by:

- **Creation:** `POST e2e.setRoomKeyID` (`rocketchat.e2e.room.ts:448`). If another member set it first, the server
  answers `error-room-e2e-key-already-exists` and the client discards its own key (`rocketchat.e2e.room.ts:37-44`,
  `449-455`).
- **Reset:** a room key reset (§8.4).

On import, the client uses `keyID = room.e2eKeyId || <wrapped-key prefix> || randomUUID()`
(`rocketchat.e2e.room.ts:412-414`). The id it encrypts under is `this.keyID` (`rocketchat.e2e.room.ts:649-653`).

### 6.4 Key selection rule

`retrieveDecryptionKey` (`rocketchat.e2e.room.ts:806-809`) is the whole rule:

```ts
const oldRoomKey = this.oldKeys?.find((key) => key.e2eKeyId === kid);
return oldRoomKey?.E2EKey ?? this.groupSessionKey;
```

- An `oldRoomKeys` entry whose `e2eKeyId` equals the message's `kid` wins.
- **Otherwise the current key is used, whatever the kid says.** The kid is never compared with the current key's
  id.
- If no key is available at all, the client shows `E2E_indecipherable` (`rocketchat.e2e.room.ts:773-776`):
  "This message is end-to-end encrypted and cannot be decrypted due to multiple room key resets".
- If AES fails, which is what happens when the fallback key is the wrong one, the client shows `E2E_Key_Error`
  (`rocketchat.e2e.room.ts:800-803`): "This message is end-to-end encrypted and cannot be decrypted due to incorrect
  encryption key". Both strings are in `packages/i18n/src/locales/en.i18n.json:2264`, `2266`.

rc-mcp (`src/e2ee/keyring.ts`, `src/e2ee/message.ts`) applies the same order: an exact `oldRoomKeys` match first,
then the current key. It reports precise reasons instead of the client's strings:

- A failure with the key the kid names is `decryption-failed` (or `invalid-plaintext` when AES succeeds but the
  plaintext is not an EJSON object).
- A failed fallback to a key with a different id is `room-key-missing`.
- No key to try (no current key and no old key with the message's kid), while some wrapped key in the
  subscription did not unwrap with the user's private key, is `room-key-undecryptable`. Usually the key was shared
  for a different key pair.
- No key to try and nothing that failed to unwrap is `no-room-key`. This is also the reason when E2EE is not
  unlocked (no password, wrong password, no keys on the account), because there is then no keyring at all.

When a subscription has no usable `E2EKey` (absent, or not unwrappable) but has an `E2ESuggestedKey`, rc-mcp uses
the suggested key as the current key. While it does, and the subscription has no `oldRoomKeys`, it also uses
`suggestedOldRoomKeys` as old keys, which is the rule the server applies on acceptance (§8.3). Nothing is accepted
on the server (see ADR 0004).

## 7. Message content

### 7.1 What the server stores

An encrypted message as stored by 8.9.0 (**observed**, the edited message `M5` of the fixtures, ciphertext
shortened):

```json
{
  "_id": "4qNPPe24xJxtMWePF",
  "rid": "6ad1459708d9d91a69c55ade",
  "t": "e2e",
  "msg": "",
  "content": {
    "algorithm": "rc.v2.aes-sha2",
    "kid": "d115000d-e8e5-46c6-88df-6ef67d741ec6",
    "iv": "alYuALj+m2e9D0x6",
    "ciphertext": "bxX2cpam5UDULnl2…"
  },
  "e2eMentions": { "e2eUserMentions": [], "e2eChannelMentions": [] },
  "ts": "…", "u": { "_id": "…", "username": "…" }, "_updatedAt": "…",
  "editedAt": "…", "editedBy": { "_id": "…", "username": "alice" },
  "mentions": [], "channels": [], "urls": []
}
```

`encryptMessage` removes `msg` and `attachments` from what is sent and adds `content`, `t: 'e2e'` and
`e2e: 'pending'` (`rocketchat.e2e.room.ts:675-688`).

### 7.2 `rc.v2.aes-sha2` (written by 7.13.0+)

The client builds it in `encryptText` / `encryptMessageContent` (`rocketchat.e2e.room.ts:640-672`) and decodes it
in `content.ts:55-63`.

| Field | Content |
| --- | --- |
| `algorithm` | `"rc.v2.aes-sha2"` |
| `kid` | The key id as a plain string (a UUID for current keys) |
| `iv` | Base64. 12 bytes with an `A256GCM` room key, 16 bytes with an `A128CBC` room key (`aes.ts:57-62`) |
| `ciphertext` | Base64. For AES-GCM: ciphertext ‖ 16-byte tag (WebCrypto default, no additional data). For AES-CBC: PKCS#7-padded ciphertext (WebCrypto AES-CBC). |

A client from 7.13.0 or later, in a room whose key predates 7.13.0 (`A128CBC`), writes `rc.v2.aes-sha2` with a
16-byte IV and AES-CBC-128. The cipher always follows the key (§6.1).

### 7.3 `rc.v1.aes-sha2` (written by 6.10.0 – 7.12.x)

```json
{"algorithm":"rc.v1.aes-sha2","ciphertext":"<kid: exactly 12 chars><base64( iv[16] ‖ AES-CBC ciphertext )>"}
```

The decoder always splits the kid off at 12 characters, then the IV at 16 bytes (`content.ts:27-48`). So v1 only
exists with 12-character key ids.

Mobile clients also wrote the same string into `msg`. Upstream fixture `msgv1mob` (`content.spec.ts:34-46`) shows
`msg` and `content.ciphertext` both set. Because `content` is checked first, the client decrypts `content`.

### 7.4 Bare string in `msg` (before 6.10.0)

There is no `content` field. `msg` holds the same `<kid 12><base64(iv16 ‖ AES-CBC ciphertext)>` string.
`normalizePayload` treats a string as v1 (`content.ts:65-71`). For this path the client only takes `msg` from the
plaintext; other plaintext fields are not merged (`rocketchat.e2e.room.ts:755-762`).

rc-mcp also keeps only `msg` here (`src/e2ee/message.ts`). One difference: when the plaintext has no string `msg`
(or `text`), the client keeps the original ciphertext string as the text, and rc-mcp returns an empty text.

### 7.5 Decision order

`decryptMessage` (`rocketchat.e2e.room.ts:736-763`):

1. If `t !== 'e2e'` or `e2e === 'done'`, the message is not encrypted. Return it unchanged.
2. If `isEncryptedMessageContent(message)` (`IMessage.ts:249-266`: algorithm is v1 or v2, `ciphertext` is a string,
   and v2 also has string `iv` and `kid`), decrypt `content` and `Object.assign` the result into the message
   (`rocketchat.e2e.room.ts:690-702`).
3. Otherwise, if `msg` is empty, there is nothing to decrypt.
4. Otherwise decrypt the bare string in `msg`.

`EncryptedContent` also lists `m.megolm.v1.aes-sha2` (Matrix federation, `IMessage.ts:138-143`). `content.ts`
cannot decode it and throws `Unsupported encryption algorithm` (`content.ts:89-90`).

### 7.6 Plaintext

The plaintext is a UTF-8 EJSON object:

| Producer | Plaintext |
| --- | --- |
| Text message, 6.10.0+ web client | `{"msg":"…"}`, plus `"attachments":[…]` when present. `encryptMessage` encrypts `{msg, attachments}` and EJSON drops `undefined` (`rocketchat.e2e.room.ts:675-678`). |
| Upload message, 8.3.0+ | `{"attachments":[…],"files":[…],"file":{…},"msg":"…"}` (`processMessageUploads.ts:67-92`, §9) |
| Upload record `content` | `{"type","typeGroup","name","encryption":{"key","iv"},"hashes":{"sha256"}}` (`uploadFiles.ts:57-68`, §9) |
| Legacy web (before 6.10.0) and mobile v1 | `{"_id":"…","text":"…","userId":"…","ts":{"$date":<ms>}}` |

The bytes are decoded with a non-fatal `TextDecoder` (`aes.ts:54`): invalid UTF-8 becomes U+FFFD rather than an
error. rc-mcp decodes the same way (`src/e2ee/content.ts`).

The mapping in `decrypt` (`rocketchat.e2e.room.ts:782-799`) works as follows:

1. Parse the EJSON. If the result is not an object, show `E2E_indecipherable`.
2. If it has a string `text` and no `msg`, rename `text` to `msg`.
3. For a `content` payload, merge every field into the displayed message with `Object.assign`
   (`rocketchat.e2e.room.ts:690-702`). For a bare `msg` payload, use only `msg` (§7.4).

### 7.7 Quotes

The composer prepends one line per quoted message, joins the lines with `\n`, and encrypts everything together
(`prependReplies.ts:5-16`, called from `data.ts:21`):

```
[ ](<absolute room URL>?msg=<quoted message id>)
<the author's text>
```

**Observed:** `[ ](http://localhost:3000/group/handbook-mva1woss?msg=Zd97mTM23F4efdEg8)\nAgreed, …`.

When displaying a message, the client extracts such URLs that point to its own `Site_Url`. For each one it fetches
the quoted message with `chat.getMessage`, decrypts it, and adds a quote attachment **locally only**
(`rocketchat.e2e.ts:717-775`). Nothing about the quote is stored in clear on the server.

rc-mcp strips the markers from `text`, returns `quotes: [{message_id, url}]`, and `get_message` resolves them into
`quoted_messages`.

### 7.8 Metadata the server sees in clear

| Feature | Clear fields | Source |
| --- | --- | --- |
| Every message | `_id`, `rid`, `t: 'e2e'`, `msg: ''`, `ts`, `u`, `_updatedAt`, `content.kid` / `content.iv` (v2) | **observed** |
| Thread reply | `tmid`, and `tshow` when also sent to the channel | **observed**; `data.ts` |
| Thread root | `tcount`, `tlm`, `replies` | **observed** |
| Edit | The client posts `chat.update {msgId, roomId, content, e2eMentions}` (`data.ts:175-192`). The server adds `editedAt` and `editedBy` (`updateMessage.ts`). With `Message_KeepHistory`, the previous ciphertext is cloned first. | **observed** (`M5`) |
| Mentions | `e2eMentions.{e2eUserMentions,e2eChannelMentions}`, extracted from the plaintext when `E2E_Enabled_Mentions` is on (default `true`, `settings/e2e.ts:46`) | `useE2EEncryption.ts:93-105` |
| File message | `file` / `files` with name = SHA-256 hex of the real name, `type: application/octet-stream`, `typeGroup: application`, `size`. `attachments` with `title` (the hashed name), `title_link`, `fileId`, `size`, `format`. No keys. | **observed**; §9 |
| Pinned message | `t: 'message_pinned_e2e'`. `attachments[0].content` holds the original encrypted content; the client decrypts it into `attachments[0].text`. | `rocketchat.e2e.ts:652-675` |

A message whose text starts with `/` is not converted by the encryption hook: `shouldConvertSentMessages` returns
false (`rocketchat.e2e.room.ts:187-189`).

## 8. Key distribution, suggested keys and room key reset

### 8.1 First key of a room

`handshake` (`rocketchat.e2e.room.ts:312-361`):

- The subscription has `E2EKey`: import it, and the room is `READY`.
- The room has no `e2eKeyId`: state `CREATING_KEYS`, then `createGroupKey` (`rocketchat.e2e.room.ts:443-467`):
  1. generate a key and claim the id with `e2e.setRoomKeyID`;
  2. wrap the key for itself and store it with `POST e2e.updateGroupKey {rid, uid, key}`;
  3. wrap it, with re-wrapped old keys, for every member returned by `e2e.getUsersOfRoomWithoutKey` and post the
     result to `e2e.provideUsersSuggestedGroupKeys` (`rocketchat.e2e.room.ts:510-553`).
- Otherwise: state `WAITING_KEYS`, and the client publishes `notify-room-users` `<rid>/e2ekeyRequest`.

### 8.2 Asynchronous distribution

Every client whose E2EE is ready runs `initiateKeyDistribution` once immediately, then every 10 s
(`rocketchat.e2e.ts:832-877`):

1. Pick the rooms with a non-empty `usersWaitingForE2EKeys` that does not include itself.
2. Sample up to 10 of them where it holds a key (`ROOM_KEY_EXCHANGE_SIZE`, `rocketchat.e2e.ts:41`).
3. `GET e2e.fetchUsersWaitingForGroupKey`.
4. Wrap the current key, and its old keys, for each waiting user (`rocketchat.e2e.room.ts:825-845`).
5. `POST e2e.provideUsersSuggestedGroupKeys`.

The server (`provideUsersSuggestedGroupKeys.ts:18-35`) handles every room the caller can access. For each recipient
it sets `E2ESuggestedKey` (and `suggestedOldRoomKeys` when given), then removes the recipients from the room's
queue.

### 8.3 Accepting a suggested key

The recipient's client handles suggested keys in two places:

- `handleAsyncE2EESuggestedKey` (`rocketchat.e2e.ts:194-225`), at startup, for subscriptions that have
  `E2ESuggestedKey` and no `E2EKey`;
- `onSubscriptionChanged` (`rocketchat.e2e.ts:122-130`), for any subscription carrying `E2ESuggestedKey`.

In both places the client runs `importGroupKey`:

- If the key unwraps and imports, the client calls `POST e2e.acceptSuggestedGroupKey`.
- Otherwise it calls `POST e2e.rejectSuggestedGroupKey`.

Acceptance only requires that the key unwraps with the user's own private key. The suggesting member is not
authenticated.

The server side is `handleSuggestedGroupKey.ts`:

- **Accept:** `E2EKey` becomes the suggested key. `oldRoomKeys` is taken from `suggestedOldRoomKeys` only if the
  subscription has no `oldRoomKeys` yet (lines 26-35). The user leaves the queue.
- **Reject:** the user is put back into the queue (lines 37-42).
- **Both:** `E2ESuggestedKey` and `suggestedOldRoomKeys` are unset (line 44).

### 8.4 Room key reset

The endpoint is `POST e2e.resetRoomKey {rid, e2eKey, e2eKeyId}` (`api/v1/e2e.ts:424-462`).

**Who can reset**

- The caller needs the permission `toggle-room-e2e-encryption` in the room (`api/v1/e2e.ts:441`) and access to the
  room. Only one reset per room runs at a time.
- The web UI offers "Reset encryption keys" from the room's "Disable E2E encryption" dialog. It does so only when
  the user's E2EE is ready **and** the room is `NOT_STARTED`, `DISABLED`, `ERROR` or `WAITING_KEYS` for that user,
  that is, when the user cannot read the room (`useE2EERoomAction.ts:31-47`).

**What the client does**

It generates a new key with a UUID id, wraps the key for itself, and posts both (`rocketchat.e2e.room.ts:469-491`,
`useE2EEResetRoomKey.ts:18-35`).

**What the server does** (`resetRoomKey.ts`)

For every subscription of the room that has `E2EKey` or `E2ESuggestedKey` (lines 31-71):

- If it has `E2EKey`, the server prepends `{e2eKeyId: room.e2eKeyId, ts: now, E2EKey}` to the existing
  `oldRoomKeys`. It sorts them **newest first** and keeps **at most 10** (`replicateMongoSlice`, lines 110-123).
  The recorded `e2eKeyId` is the room's key id **before** the reset.
- It unsets `E2EKey`, `E2ESuggestedKey` and `suggestedOldRoomKeys` (line 51). A suggested key that was never
  accepted is dropped, not archived.
- Every member other than the resetter is queued in `usersWaitingForE2EKeys`, at most 50 entries
  (`pushToLimit`, lines 57-66, 91-99).

Then the server sets `room.e2eKeyId` to the new id and saves the queue (line 79). Finally it sets the resetter's
`E2EKey` to the new wrapped key (line 81).

**How members get the new key**

1. Members' clients see that `room.e2eKeyId` changed (`rocketchat.e2e.ts:263-270`). `onRoomKeyReset` puts the room
   into `WAITING_KEYS` (`rocketchat.e2e.room.ts:493-508`).
2. An online client that holds the new key delivers it through §8.2 as `E2ESuggestedKey` and
   `suggestedOldRoomKeys`. Right after the reset, only the resetter holds it.
3. Each recipient's client accepts it (§8.3). Accepting keeps their existing `oldRoomKeys`.

**Consequences**

- Members keep reading pre-reset messages through `oldRoomKeys`, up to 10 key generations back.
- A member who never had the old key cannot read them. **Observed:** after resetting, the admin's real client shows
  `E2E_Key_Error` for every pre-reset message, and rc-mcp reports `room-key-missing` for the same messages.
- **Observed real-client quirk:** after a reset, a reopened official client sometimes showed pre-reset messages as
  placeholders until the page was reloaded. A reloaded client and rc-mcp read them through `oldRoomKeys`.

### 8.5 Account key reset

`POST users.resetE2EKey` and the deprecated method `e2e.resetOwnE2EKey` both call `resetUserE2EEncriptionKey`
(`resetUserE2EKey.ts:59-84`). It:

- unsets `users.e2e` (`Users.ts:2215-2224`);
- unsets `E2EKey`, `E2ESuggestedKey` **and `oldRoomKeys`** on all the user's subscriptions
  (`Subscriptions.ts:949-960`);
- removes the user from every key queue;
- unsets all of the user's login tokens.

The token wipe also revokes personal access tokens, so rc-mcp starts getting HTTP 401 and the user must create a
new token. This was observed against the 8.9.0 compose stack.

What rc-mcp then shows, from the source (not captured):

1. HTTP 401 until a new PAT is configured.
2. `no-user-keys` until the official client has created the new key pair.
3. Rooms with `key_status: missing` (messages `no-room-key`) until a member's client re-shares the room key (§8.2).
4. A member's client that re-shares the key also re-wraps its own `oldRoomKeys` for the user, as
   `suggestedOldRoomKeys` (`rocketchat.e2e.room.ts:825-845`). The reset removed the user's `oldRoomKeys`, so rc-mcp
   uses those suggested old keys while the key is pending, and the server copies them into `oldRoomKeys` on
   acceptance (§8.3). History encrypted with those keys is readable either way.
5. History encrypted with a key that the re-sharing member does not hold reports `room-key-missing`.

## 9. File encryption

### 9.1 Per-file encryption

`encryptFile` (`rocketchat.e2e.room.ts:608-637`) works per file:

| Item | Value |
| --- | --- |
| Key | A fresh AES-CTR 256-bit key per file (`helper.ts:5-7`), exported as a JWK. In WebCrypto's export, `alg` is `A256CTR`. |
| Counter block (`iv`) | 16 random bytes (`rocketchat.e2e.room.ts:615`), base64 |
| Counter length | `length: 64`. The low 64 bits of the block are the counter (`helper.ts:1-3`, `enc.js:24-30`). |
| Integrity | `hash` = lowercase hex SHA-256 of the **plaintext** (`rocketchat.e2e.room.ts:613`, `helper.ts:50-53`). There is no MAC: AES-CTR is unauthenticated and length-preserving. |
| Uploaded file name | Lowercase hex SHA-256 of the UTF-8 original name (`rocketchat.e2e.room.ts:626`, `helper.ts:43-48`) |

### 9.2 Upload flow (8.9.0)

1. **`POST /api/v1/rooms.media/:rid`** (multipart).
   - Field `file` is the ciphertext under the hashed name.
   - Field `content` is `JSON.stringify` of the encrypted upload metadata (`uploads.ts:155-162`).
   - The upload metadata is `encryptMessageContent({type, typeGroup, name, encryption: {key, iv}, hashes: {sha256}})`
     (`uploadFiles.ts:57-75`).
   - The server stores `content` on the upload record with `expiresAt` set to now + 24 h (`api/v1/rooms.ts:288-309`).
   - It forces `type: application/octet-stream` for E2EE uploads (`FileUpload.ts:190-193`).
2. **`POST /api/v1/rooms.mediaConfirm/:rid/:fileId`** with `{tmid, content, t: 'e2e', msg: '', fileContent}`
   (`processMessageUploads.ts:137-151`).
   - The server replaces the upload record's `content` with `fileContent` (`api/v1/rooms.ts:357-359`).
   - It then sends the file message.
   - `fileContent` re-encrypts the upload metadata. The client may have changed it after the upload: alt text,
     rename (`uploads.ts:77`, `96`).

### 9.3 Where the real metadata lives

Real name, MIME type, size, key, counter block and hash exist **only inside encrypted content**:

- **Message `content`** (`processMessageUploads.ts:29-92`):

  ```json
  {
    "attachments": [{
      "title": "<real name>", "type": "file", "title_link": "<url>", "title_link_download": true,
      "encryption": { "key": { "kty": "oct", "k": "…", "alg": "…", "…": "…" }, "iv": "<base64 16 bytes>" },
      "hashes": { "sha256": "<hex>" },
      "fileId": "<upload id>",
      "size": 1234, "format": "md"
    }],
    "files": [{ "_id": "<upload id>", "name": "<real name>", "type": "<mime>", "size": 1234, "format": "md" }],
    "file":  { "_id": "<upload id>", "name": "<real name>", "type": "<mime>", "size": 1234, "format": "md" },
    "msg": "<composer text, first file only>"
  }
  ```

  - For image, audio and video files the attachment carries `<kind>_url`, `<kind>_type` and `<kind>_size` instead of
    `size`/`format`. Images also get `image_dimensions` and `image_alt`.
  - Since 8.3.0 each file gets its own message. Only the first one carries the composer text
    (`processMessageUploads.ts:115-119`).
- **Upload record `content`**: `{type, typeGroup, name, encryption, hashes}`. This is what `groups.files` /
  `im.files` return encrypted.

**Observed in clear:** `file.name` is a 64-hex-char hash, `type` is `application/octet-stream`, `typeGroup` is
`application`, and `size` is the ciphertext size. Because AES-CTR preserves length, that is also the plaintext size.

### 9.4 Download

The ciphertext is served at `/file-upload/<id>/<name>` (the upload record's `path`). The official client decrypts
it in the `enc.js` service worker: AES-CTR with `counter = iv` and `length: 64` (`enc.js:24-30`).

The official client writes `hashes.sha256` but **never checks it**. The only references to `hashes` in the client
are in `uploadFiles.ts` and `processMessageUploads.ts`. rc-mcp verifies the hash when it is present and reports
`file-hash-mismatch` (`src/e2ee/file.ts`).

### 9.5 Removed files

Since 8.2.0 the server may replace attachments with clear `{type: 'removed-file', fileId?}` entries. After decrypting,
the client swaps decrypted file attachments for those entries (`decryptMessageContent`,
`rocketchat.e2e.room.ts:696-733`):

- Nothing changes unless the server copy has `removed-file` entries and the decrypted content has attachments.
- Only file attachments are touched: `type: 'file'`, or an `image_url`, `audio_url` or `video_url`
  (`isFileAttachment`).
- A `removed-file` entry without `fileId` replaces every file attachment.
- Otherwise an attachment is replaced by the entry whose `fileId` equals the attachment's `fileId`, or the
  message's `file._id` when the attachment has none.

rc-mcp ports this rule as is (`src/e2ee/message.ts`, `mergeContent`).

## 10. Deletion semantics

`deleteMessage` (`deleteMessage.ts:31-100`) depends on two settings. A thread root (`tcount > 0`) always behaves as
if both were on.

| `Message_KeepHistory` | `Message_ShowDeletedStatus` | Effect on the message | Effect on its files |
| --- | --- | --- | --- |
| on | on | History copy is cloned, then the message becomes a tombstone | Uploads marked `_hidden` |
| on | off | Message hidden (`_hidden`) | Uploads marked `_hidden` |
| off | on | Message becomes a tombstone | Deleted from the store |
| off | off | Message removed from the collection | Deleted from the store |

- **Tombstone** (`Messages.ts:1158-1183`): `t: 'rm'`, `msg: ''`, `attachments: []`, plus `editedAt` / `editedBy`.
  `md`, `blocks` and `tshow` are unset. **`content` is not unset**, so the ciphertext stays in the document.
- **Removal goes through the trash.** `deleteOne` copies the full document, `content` included, into the trash
  collection with `_deletedAt` (`BaseRaw.ts:319-345`). Trash entries expire after 30 days through a TTL index on
  `_deletedAt` (`Trash.ts:18`).
- **Sync:** `chat.syncMessages?lastUpdate=<date>` returns `updated` (messages with `_updatedAt > lastUpdate`) and
  `deleted` (trash entries with `_deletedAt > lastUpdate`, as `{_id, _deletedAt}`), unpaginated
  (`publications/messages.ts:143-158`, `api/v1/chat.ts:667-760`).
- **Deleting does not rotate the room key.** Anyone holding the room key can still decrypt a deleted message's
  ciphertext wherever a copy survives: client caches, the server's trash for 30 days, history clones, tombstones,
  backups.

rc-mcp removes from its index every message listed in `deleted` and every message whose `t` is `rm`. It does a
full resync of any room whose cursor is older than 29 days, because the trash no longer covers that gap
(`src/index/sync.ts`).

**Limitation: hidden deletions.** With `Message_KeepHistory` on and `Message_ShowDeletedStatus` off, a deleted
message is only marked `_hidden` (`deleteMessage.ts:56-61`). It creates no trash entry and no tombstone, and both
`chat.syncMessages` and `rooms.history` skip `_hidden` messages (`Messages.ts:862-875`, `Messages.ts:906` onwards).
No sync endpoint reports such a deletion, so the message stays in rc-mcp's index until `rc-mcp sync --full`.
`get_message` reports `message-deleted` when it fetches a message that the server returns with `_hidden: true`, but
it answers from the index first.

## 11. Discrepancies with public docs

The page compared is <https://docs.rocket.chat/docs/end-to-end-encryption-specifications>, as read on
2026-10-15. The statements below paraphrase that page; the page may have changed since, so re-check it when
updating this section.

Where the page and the code differ, this project follows the 8.9.0 source and the real-client fixtures.

| Topic | Public docs | 8.9.0 source / fixtures |
| --- | --- | --- |
| Master key derivation | "AES-GCM, 256-bit, PBKDF2 with 100,000 iterations and random salt"; hash not stated | Applies to v2 backups only. The hash is SHA-256. The salt is `v2:<userId>:<random UUID>`, which embeds the user id, so it is not purely random. v1 backups (`$binary`, salt = user id, 1000 iterations, AES-CBC-256) are still accepted, and stay v1 until the password is saved again (§4, §5). |
| Password bytes | Not stated | Latin-1 code units via `Binary.decode`, not UTF-8. Characters above U+00FF are rejected (§4). |
| Recovery phrase | "mnemonic recovery phrase", no format | 12 words from the BIP-39 English list (2048 words), space-separated (`helper.ts:17-41`). Users can also set their own password (`changePassword`, `rocketchat.e2e.ts:435-441`). |
| Message on the wire | `final_message: { msg: <encrypted_message>, t: "e2e" }` | Since 6.10.0 the ciphertext is in `content` and `msg` is `''`. Since 7.13.0 `content` is `{algorithm: 'rc.v2.aes-sha2', kid, iv, ciphertext}` (§7). An encrypted `msg` only appears in pre-6.10 messages and in mobile v1 messages. |
| Ciphertext layout | "keyID + encrypted content" | True only for `rc.v1.aes-sha2` and legacy bare strings (12-char kid + base64(iv16 ‖ ct)). `rc.v2` carries `kid` and `iv` as separate fields (§7.2, §7.3). |
| Message cipher | Messages are encrypted with the AES-GCM session key | Only when the room key is `A256GCM`. Rooms whose key predates 7.13.0 still use AES-CBC-128, even under the `rc.v2` label. The JWK `alg` decides (§6.1). |
| Key ID | "derived from the encryption key" | Since 7.13.0 a random UUID (`rocketchat.e2e.room.ts:434`), not derived from the key. Earlier generations were 12-char derivations (§6.3). The id also prefixes every wrapped key (§6.2). |
| Decryption key choice | Compare the message keyID with the room's. If equal, use the current key. Otherwise search `oldRoomKeys`. | `oldRoomKeys` is searched first, by exact id. If nothing matches, the current key is used **without any id comparison** (§6.4). |
| Key distribution endpoint | `e2e.provideUsersWithSuggestedGroupKeys` (the page's handshake section names `provideUsersSuggestedGroupKeys()`) | The endpoint is `e2e.provideUsersSuggestedGroupKeys` (`api/v1/e2e.ts:400`). No endpoint with the first name exists in 8.9.0. |
| Files | "The same decryption logic applies to file encryption." | Files use their own AES-CTR-256 key and 16-byte counter block (`length` 64), carried inside the encrypted message content. The room key only protects that metadata. Names are hashed and the type is forced to `application/octet-stream` (§9). |
| `oldRoomKeys` | Limited to 10 elements; the oldest is deleted | Agrees: sorted newest first, sliced to 10 (`resetRoomKey.ts:110-123`). Unaccepted suggested keys are dropped on reset (§8.4). |
| RSA | RSA-OAEP, 2048-bit, SHA-256, exponent 65537 | Agrees (`rsa.ts:20-33`). |
| `e2e.resetRoomKey` | Takes `rid`, `e2eKey`, `e2eKeyId` | Agrees (`api/v1/e2e.ts:440`). It also requires `toggle-room-e2e-encryption` (§8.4). |

## 12. Version history

This section summarises a read-only survey of Rocket.Chat's git history, tags and pull requests (2026-10-15). Each
"first version" is the first release tag that contains the change.

| First version | Change | PR |
| --- | --- | --- |
| 0.70.0 | E2EE introduced. AES-CBC-128 room keys. Kid = first 12 chars of base64(JWK JSON). Payload `kid12 + base64(iv16 ‖ ct)` in `msg`. Plaintext `{_id, text, userId, ts}`. Private-key backup v1 (PBKDF2-SHA-256, 1000 iterations, salt = user id, AES-CBC-256). | #10094 |
| 0.71.0 | Decrypted plaintext decoded as UTF-8 (before: byte-wise) | #12398 |
| 4.4.4 / 4.5.0 | Generated password = 5 words from a 1633-word list (before: 3 groups of 3 random characters) | #24114 |
| 6.0.0 | Suggested keys: `E2ESuggestedKey`, `e2e.acceptSuggestedGroupKey` / `e2e.rejectSuggestedGroupKey` | #27556 |
| 6.10.0 | Ciphertext moved to `content = {algorithm: 'rc.v1.aes-sha2', ciphertext}`. Plaintext `{msg, attachments}`. Encrypted file uploads (per-file AES-CTR-256 key, hashed file name). | #32316 |
| 6.10.0 | Asynchronous key distribution (`usersWaitingForE2EKeys`, `e2e.provideUsersSuggestedGroupKeys`) | #32197 |
| 6.10.0 | `hashes.sha256` of the file plaintext | #32714 |
| 6.10.0 | Encrypted pins (`message_pinned_e2e`, ciphertext in `attachments[0].text`) | #32380 |
| 6.10.0 | Setting `E2E_Allow_Unencrypted_Messages` (default changed in 7.0.0, #33361) | #32040 |
| 6.12.0 | Setting `E2E_Enable_Encrypt_Files`; E2EE uploads use `application/octet-stream` | #33003 |
| 6.13.0 | Plaintext `e2eMentions`, setting `E2E_Enabled_Mentions` (default `true` since 7.0.0, #33419) | #32510 |
| 7.0.0 | Kid = first 12 hex chars of SHA-256(JWK JSON); marked as a breaking change | #33329 |
| 7.0.0 | Room key reset; subscription `oldRoomKeys` / `suggestedOldRoomKeys` | #33328 |
| 7.1.0 | Room and helper code migrated from JS to TS; no format change | #33636 |
| 7.2.0 | Any member may create and propagate room keys (reverts the creator-only rule of #33520 from 7.0.0) | #34038 |
| 7.10.0 | Client code moved to `apps/meteor/client/lib/e2ee/` | #36722 |
| 7.13.0 | "e2ee security hardening": `rc.v2.aes-sha2` (separate `kid` / `iv`); new room keys AES-GCM-256; UUID key ids; wrapped-key prefix of any length; private-key backup v2 (AES-GCM, 100 000 iterations, salt `v2:<uid>:<uuid>`); 12-word BIP-39 passphrase; pinned messages also carry `attachments[0].content`. **Not in the changelog.** | #36942 |
| 7.13.0 | Complexity requirements for user-chosen passphrases (no format change) | #37327 |
| 8.0.0 | Deprecated Meteor method `e2e.updateGroupKey` removed (the REST endpoint remains) | #36647 |
| 8.0.0 | `/api/v1/rooms.upload` removed; uploads use `rooms.media` + `rooms.mediaConfirm` | #36857 |
| 8.2.0 | `removed-file` attachments on encrypted messages | #38379 |
| 8.3.0 | Multiple-file uploads: one message per file, only the first carries the text; image `description` replaced by `image_alt` | #39425 |
| 8.3.0 | `enc.js` `key` query parameter URI-encoded (client-side only) | #39612 |
| 8.6.0 | `POST e2e.requestSubscriptionKeys` | #40724 |
| 8.7.0 | Setting the room key id is first-write-wins on the server | #41169 |
| 8.7.0 | Server code moved to `apps/meteor/server/lib/e2e/` | #41315 |
| 8.8.0 | Setting `E2E_Force_Encryption_For_Private_Rooms` | #41095 |

Not determined: whether any client before 6.10.0 uploaded files through the old AES-CBC `encryptFile`, and the
history of the mobile apps' formats. The mobile apps live in another repository.

## 13. How this is verified

No test encrypts with rc-mcp's code to prove compatibility. Every ciphertext the tests decrypt was produced by
Rocket.Chat's own code (ADR 0003).

**Real-client fixtures, `test/fixtures/8.9.0`**

`scripts/generate-fixtures.ts` drives the real 8.9.0 web client with Playwright. The capture covers:

- v2 private-key backups for three users, unlocked with the passphrases captured from the client's
  "Save your new E2EE password" modal;
- A256GCM room keys with UUID ids;
- `rc.v2.aes-sha2` messages: plain, long multi-paragraph Unicode, Markdown, a thread reply, an edit, a quote;
- encrypted text and image uploads, in both message `content` and upload-record `content`;
- an encrypted DM;
- a room key reset with `oldRoomKeys`, done by a member who never held the old key.

`test/support/fixture-suite.ts` asserts that:

- the decrypted text equals the typed text and what the real client rendered, including the reset member's failures;
- the REST copy and the raw MongoDB document of each message decrypt identically;
- files decrypt byte for byte with their SHA-256 verified.

**Upstream vectors, `test/fixtures/upstream/legacy-v1.json`**

These are extracted by `scripts/extract-upstream-vectors.ts` from Rocket.Chat's own end-to-end test fixtures (MIT):
`apps/meteor/tests/e2e/fixtures/userStates.ts` and `apps/meteor/tests/e2e/e2e-encryption/e2ee-legacy-format.spec.ts`.
They cover:

- a v1 `$binary` private key (salt `userE2EE`, 1000 iterations);
- a 12-character key id (`32c9e7917b78`) with an A128CBC room key (356-character wrapped string);
- a legacy bare-`msg` payload whose plaintext uses `text`.

`test/unit/e2ee/upstream-legacy.test.ts` checks them.

**Fresh capture**

`mise run test:ground-truth` repeats the real-client capture against the running stack into
`.local/ground-truth/<version>` (not committed) and runs the same suite.

**Implemented from source only**, with no captured artifact yet:

- `rc.v1.aes-sha2` as a `content` object (it uses the same decoder as the legacy bare string, which is covered);
- `rc.v2` carrying an A128CBC key;
- encrypted pins;
- `t: 'rm'` tombstones;
- `removed-file` attachments;
- `suggestedOldRoomKeys`.

The suggested-key path is unit-tested by presenting a captured key as `E2ESuggestedKey`
(`test/unit/e2ee/failure-modes.test.ts`), and the `suggestedOldRoomKeys` path by presenting a captured member's
`oldRoomKeys` in that field with no `oldRoomKeys` of its own (`test/unit/mcp/review-regressions.test.ts`).

**Supporting a new Rocket.Chat version**

1. Set `RC_VERSION` in `.mise.toml`.
2. Run `mise run rc:down && mise run rc:up && mise run fixtures:generate`, then run the tests.
3. Diff `apps/meteor/client/lib/e2ee` between the tags and update this document.

## 14. What rc-mcp supports

| Item | Supported | Notes |
| --- | --- | --- |
| Private key backup | v1 `$binary`, v2 `{iv, ciphertext, salt, iterations}` | `src/e2ee/private-key.ts` |
| Room key JWK | `A256GCM`, `A128CBC` | Any other `alg` is reported as `unsupported-algorithm` (`src/e2ee/room-key.ts`) |
| Key sources | `E2EKey`, `E2ESuggestedKey` (when there is no usable `E2EKey`), `oldRoomKeys`, `suggestedOldRoomKeys` (while the suggested key is in use and there are no `oldRoomKeys`) | Suggested keys are used read-only and never accepted (`src/e2ee/keyring.ts`, ADR 0004) |
| Message content | `rc.v2.aes-sha2`, `rc.v1.aes-sha2`, legacy bare `msg`, `message_pinned_e2e` | `m.megolm.v1.aes-sha2` is reported as `unsupported-algorithm` |
| Files | AES-CTR-256, `length` 64, SHA-256 checked | `src/e2ee/file.ts` |

Failure reasons (`src/e2ee/errors.ts`): `no-e2ee-password`, `no-user-keys`, `wrong-password`, `unsupported-password`,
`no-room-key`, `room-key-missing`, `room-key-undecryptable`, `unsupported-algorithm`, `malformed-payload`,
`decryption-failed`, `invalid-plaintext`, `file-key-missing`, `file-hash-mismatch`.
