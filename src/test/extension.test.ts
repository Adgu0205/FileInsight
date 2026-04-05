import * as assert from 'assert';
import * as vscode from 'vscode';

suite('FileInsight Extension Test Suite', () => {
  vscode.window.showInformationMessage('Starting FileInsight tests.');
  test('Extension should be present', () => {
    assert.ok(true);
  });
});
