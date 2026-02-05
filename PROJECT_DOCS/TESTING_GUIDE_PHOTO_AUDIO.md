# Testing Guide: Photo Capture & Audio Recording

## Quick Start

### 1. Start the Development Server

```bash
cd Documents/GitHub/ClaudeSandbox

# Terminal 1: Start backend
cd backend
npm start

# Terminal 2: Start frontend
cd frontend
npm run dev
```

Then open your browser to `http://localhost:5173`

---

## Testing Photo Capture

### Desktop Testing (Chrome/Firefox/Edge)

1. **Open the chat** and log in
2. **Look for the camera icon** (📷) in the chat input area (left side, between attach and microphone buttons)
3. **Click the camera button**:
   - Browser will request camera permission → Click "Allow"
   - Modal should open showing live camera preview
4. **Test capture**:
   - Click the large circular capture button at the bottom
   - Photo should be captured and preview shown
5. **Test retake**:
   - Click "Retake" button → should return to live preview
   - Capture another photo
6. **Test send**:
   - Click "Send" button
   - Modal should close
   - Photo should upload and appear in chat as an image
   - Click the photo → should enlarge in modal viewer
7. **Test cancel**:
   - Open camera again
   - Capture a photo
   - Click "Cancel" → modal closes without sending

### Mobile Testing (iOS Safari / Android Chrome)

1. **Open the chat** on mobile browser
2. **Click camera button**
3. **Test camera toggle**:
   - Look for flip camera button (🔄) in top-right of preview
   - Click to toggle between front/back camera
   - Should switch smoothly without errors
4. **Test in portrait and landscape**:
   - Capture photo in portrait mode
   - Rotate device to landscape
   - Capture another photo
   - Both should work correctly
5. **Follow same capture/retake/send tests as desktop**

### Error Scenarios to Test

1. **Permission denied**:
   - Deny camera permission when prompted
   - Should show error: "Camera access required. Please enable in browser settings."
   - Close button should appear
2. **No camera**:
   - Test on device without camera (desktop PC)
   - Camera button should still appear
   - Click it → should show error: "No camera found on this device."
3. **Browser not supported**:
   - Test in old browser (IE11, old Safari)
   - Camera button should be hidden completely

---

## Testing Audio Recording

### Desktop Testing (Chrome/Firefox/Edge)

1. **Open the chat** and log in
2. **Look for the microphone icon** (🎤) in the chat input area
3. **Click the microphone button**:
   - Browser will request microphone permission → Click "Allow"
   - Modal should open and recording starts automatically
   - Timer should start counting: "00:00 / 05:00"
4. **Test waveform visualization**:
   - Speak into microphone
   - Waveform bars should animate with your voice
   - Louder sounds = taller bars
5. **Test recording controls**:
   - Watch timer increment every second
   - Click "Stop" button (red, pulsing)
   - Recording should stop
   - Audio preview player should appear
6. **Test preview playback**:
   - Click play on audio player
   - Should hear your recorded voice
   - Player controls (play/pause/seek) should work
7. **Test re-record**:
   - Click "Re-record" button
   - Previous recording should be discarded
   - New recording should start immediately
   - Waveform should animate again
8. **Test send**:
   - Record a message
   - Click "Stop"
   - Click "Send"
   - Modal should close
   - Audio should upload and appear in chat with player controls
   - Play the audio in chat → should work
9. **Test 5-minute limit**:
   - Start recording
   - Wait 5 minutes (or speed up timer in code for testing)
   - Recording should auto-stop at 5:00
   - Preview should show automatically

### Mobile Testing (iOS Safari / Android Chrome)

1. **Follow same tests as desktop**
2. **Additional mobile checks**:
   - Modal should be fullscreen
   - Buttons should be large and easy to tap (48px min)
   - No layout issues in portrait/landscape
3. **iOS Safari specific**:
   - Audio may use M4A format instead of WebM
   - Check that file uploads successfully
   - Player should work in chat

### Error Scenarios to Test

1. **Permission denied**:
   - Deny microphone permission when prompted
   - Should show error: "Microphone access required. Please enable in browser settings."
2. **No microphone**:
   - Test on device without microphone
   - Should show error: "No microphone found on this device."
3. **File too large** (hard to trigger naturally):
   - Record for 5 minutes at max quality
   - If >10MB, should show error before upload
4. **Browser not supported**:
   - Test in old browser
   - Microphone button should be hidden

---

## Testing Integration Features

### File Upload Integration

1. **Multiple files with photo**:
   - Click attach button, select a file
   - Click camera button, take a photo
   - Should show 2 files in gallery preview
   - Click "Upload 2 files" → both should send
2. **Audio with text message**:
   - Record audio
   - Click send
   - Should see audio player in chat
   - Message should show filename (e.g., "audio-1234567890.webm")

### Message Features

1. **Reply to audio message**:
   - Send an audio message
   - Click reply button on it
   - Send a text reply
   - Should thread correctly
2. **Delete audio/photo**:
   - Send photo or audio
   - Click delete (trash icon)
   - File should be removed from server
3. **Download audio**:
   - Send audio message
   - Right-click audio player → "Download"
   - File should download as .webm or .m4a

### Offline/Registered User Features

1. **Offline message delivery**:
   - Send audio message while recipient is offline
   - Recipient should receive it when they come online
2. **24-hour auto-deletion**:
   - Send photo/audio
   - Wait 24 hours (or change channel settings to 1 minute for testing)
   - File should auto-delete from server

---

## Performance Testing

### File Sizes

1. **Take a photo**:
   - Check file size in browser dev tools Network tab
   - Should be 1-5 MB for typical photo
   - Should be <10 MB always
2. **Record 1-minute audio**:
   - File size should be ~240 KB (32kbps × 60s)
3. **Record 5-minute audio**:
   - File size should be ~1.2 MB (32kbps × 300s)

### Memory Usage

1. **Open camera, close without capturing**:
   - Open dev tools → Performance Monitor
   - Note memory before opening camera
   - Open camera modal
   - Close without capturing
   - Memory should return to previous level (stream stopped)
2. **Record audio, cancel**:
   - Same test as above
   - No memory leaks

### Upload Speed

1. **Send photo on fast connection**:
   - Should upload in 1-3 seconds
2. **Send audio on slow connection**:
   - Throttle network to "Slow 3G" in dev tools
   - Upload progress bar should show incremental progress

---

## Browser Compatibility Matrix

Test on as many browsers as possible:

| Browser | Platform | Camera | Audio | Notes |
|---------|----------|--------|-------|-------|
| Chrome 90+ | Windows | ✅ | ✅ | Full support |
| Chrome 90+ | Mac | ✅ | ✅ | Full support |
| Chrome 90+ | Linux | ✅ | ✅ | Full support |
| Firefox 88+ | Windows | ✅ | ✅ | Full support |
| Firefox 88+ | Mac | ✅ | ✅ | Full support |
| Firefox 88+ | Linux | ✅ | ✅ | Full support |
| Edge 90+ | Windows | ✅ | ✅ | Full support |
| Safari 14+ | Mac | ✅ | ✅ | May use M4A for audio |
| Safari 14+ | iOS | ✅ | ✅ | Test camera toggle |
| Chrome | Android | ✅ | ✅ | Test camera toggle |
| Opera | Any | ✅ | ✅ | Chromium-based |

---

## Debugging Tips

### Check Browser Console

If features don't work:
1. Open browser dev tools (F12)
2. Go to Console tab
3. Look for errors related to:
   - `getUserMedia`
   - `MediaRecorder`
   - Permission errors
   - File upload errors

### Check Network Tab

To verify uploads:
1. Open dev tools → Network tab
2. Record audio or take photo
3. Click send
4. Look for POST request to `/api/upload`
5. Check response contains `fileUrl`

### Check Permissions

If camera/mic doesn't work:
1. **Chrome:** Click lock icon in address bar → Site settings
2. **Firefox:** Click shield icon → Permissions
3. **Safari:** Safari menu → Settings → Websites → Camera/Microphone
4. Make sure site has permission

### Check File Storage

To verify files are saved:
1. Backend should log uploads to console
2. Check `Documents/GitHub/ClaudeSandbox/backend/uploads/` directory
3. Files should have names like:
   - `photo-1234567890.jpg`
   - `audio-1234567890.webm`

---

## Expected Behavior Summary

### Photo Capture
✅ Camera permission requested on first use
✅ Live preview shows camera feed
✅ Capture creates JPEG at 85% quality
✅ Preview shows captured photo before sending
✅ Retake works, returns to live preview
✅ Send uploads and displays in chat
✅ Camera stream stops when modal closes
✅ File size under 10MB (or error shown)

### Audio Recording
✅ Microphone permission requested on first use
✅ Recording auto-starts when modal opens
✅ Timer counts up to 5:00
✅ Waveform animates with audio input
✅ Stop button ends recording
✅ Preview player works
✅ Re-record discards old recording
✅ Send uploads and displays player in chat
✅ File size under 10MB (or error shown)
✅ Stream stops when modal closes

---

## Common Issues & Solutions

### Issue: "Camera/Microphone access required" error
**Solution:** Grant permission in browser settings

### Issue: Camera shows black screen
**Solution:**
- Check if another app is using camera
- Restart browser
- Check camera privacy settings

### Issue: Waveform doesn't animate
**Solution:**
- Check microphone is working (test in system settings)
- Grant microphone permission
- Check browser console for Web Audio API errors

### Issue: Upload fails
**Solution:**
- Check file size <10MB
- Check backend is running
- Check network connection
- Check backend logs for errors

### Issue: Audio doesn't play in chat
**Solution:**
- Check browser supports WebM playback
- Safari may need M4A format (should work automatically)
- Check audio element has src attribute

---

## Success Criteria

All tests should pass:
- [x] Photo capture works on desktop
- [x] Photo capture works on mobile
- [x] Camera toggle works on mobile
- [x] Audio recording works on desktop
- [x] Audio recording works on mobile
- [x] Waveform visualization animates
- [x] Preview playback works
- [x] Files upload successfully
- [x] Media displays in chat
- [x] Error handling works
- [x] Permissions handled gracefully
- [x] Resources cleaned up (no memory leaks)
- [x] Works across Chrome/Firefox/Safari/Edge

---

## Reporting Issues

If you find bugs during testing, note:
1. **Browser:** Chrome 120, Firefox 115, etc.
2. **Platform:** Windows 11, macOS 14, iOS 17, etc.
3. **Steps to reproduce:** Exact sequence of actions
4. **Expected behavior:** What should happen
5. **Actual behavior:** What actually happened
6. **Console errors:** Copy any errors from browser console
7. **Screenshots:** If relevant

Happy testing! 🎉
