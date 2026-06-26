if (typeof browser === 'undefined') var browser = chrome;

document.getElementById('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;

  const status = document.getElementById('status');
  status.className = '';
  status.textContent = 'Reading file...';

  try {
    const text = await file.text();

    // Basic JSON validation before sending
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      status.className = 'err';
      status.textContent = '❌ Invalid JSON file.';
      return;
    }

    if (!parsed.legendStats || typeof parsed.legendStats !== 'object') {
      status.className = 'err';
      status.textContent = '❌ Invalid file: missing legendStats.';
      return;
    }

    status.textContent = 'Importing...';

    const response = await browser.runtime.sendMessage({
      type: 'IMPORT_LEGEND_STATS',
      data: text
    });

    if (response && response.success) {
      status.className = 'ok';
      status.textContent = `✅ Imported ${response.sitesImported} site(s) successfully! Closing...`;
      setTimeout(() => window.close(), 2000);
    } else {
      status.className = 'err';
      status.textContent = '❌ Import failed: ' + (response ? response.error : 'No response from background.');
    }
  } catch (err) {
    status.className = 'err';
    status.textContent = '❌ Error: ' + err.message;
  }

  // Reset so same file can be re-selected
  event.target.value = '';
});
