// The 99-phone-removed flow's step: the computer removes this phone now (removal-server.mjs).
const response = http.post('http://127.0.0.1:41731/remove', { body: '' })
if (response.status !== 200) {
  throw new Error('The computer did not remove the phone: ' + response.status + ' ' + response.body)
}
