"use strict";

const { Notice, Plugin, PluginSettingTab, Setting, requestUrl } = require("obsidian");

const DEFAULT_SETTINGS = {
	clientId: "",
	clientSecret: "",
	refreshToken: "",
	redirectUri: "https://jprastello09.github.io/obsidian-drive-importer/",
	driveFolderId: "",
	targetFolder: "",
	importedFileIds: [],
};

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SCOPE = "https://www.googleapis.com/auth/drive.readonly";

const PLAIN_TEXT_MIME_TYPES = new Set(["text/markdown", "text/plain"]);
const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";

// Tipos que baixamos como anexo binário (sem conversão de texto).
const BINARY_MIME_TYPES = {
	"application/pdf": "pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/msword": "doc",
};

class DriveImporterPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.addCommand({
			id: "import-new-files-from-drive",
			name: "Importar novos arquivos do Google Drive",
			callback: () => this.importFromDrive(),
		});

		this.addRibbonIcon("download", "Importar do Google Drive", () => {
			this.importFromDrive();
		});

		this.addSettingTab(new DriveImporterSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	buildAuthUrl() {
		const params = new URLSearchParams({
			client_id: this.settings.clientId,
			redirect_uri: this.settings.redirectUri,
			response_type: "code",
			scope: SCOPE,
			access_type: "offline",
			prompt: "consent",
		});
		return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
	}

	async exchangeCodeForRefreshToken(code) {
		const response = await requestUrl({
			url: GOOGLE_TOKEN_ENDPOINT,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams({
				code,
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				redirect_uri: this.settings.redirectUri,
				grant_type: "authorization_code",
			}).toString(),
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(
				`Falha ao trocar o código pelo refresh token (status ${response.status}): ${response.text}`
			);
		}

		const data = response.json;
		if (!data.refresh_token) {
			throw new Error(
				"O Google não retornou um refresh_token. Revogue o acesso do app em myaccount.google.com/permissions e tente de novo."
			);
		}

		this.settings.refreshToken = data.refresh_token;
		await this.saveSettings();
	}

	async getAccessToken() {
		if (!this.settings.refreshToken) {
			throw new Error(
				"Nenhum refresh token configurado. Autorize o acesso ao Google Drive nas configurações do plugin primeiro."
			);
		}

		const response = await requestUrl({
			url: GOOGLE_TOKEN_ENDPOINT,
			method: "POST",
			contentType: "application/x-www-form-urlencoded",
			body: new URLSearchParams({
				refresh_token: this.settings.refreshToken,
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				grant_type: "refresh_token",
			}).toString(),
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(
				`Falha ao renovar o access token (status ${response.status}): ${response.text}`
			);
		}

		return response.json.access_token;
	}

	async listDriveFiles(accessToken) {
		if (!this.settings.driveFolderId) {
			throw new Error("Nenhuma pasta do Google Drive configurada nas configurações do plugin.");
		}

		const query = encodeURIComponent(
			`'${this.settings.driveFolderId}' in parents and trashed = false`
		);
		const fields = encodeURIComponent("files(id,name,mimeType,modifiedTime)");
		const url = `${DRIVE_API}/files?q=${query}&fields=${fields}&pageSize=100`;

		const response = await requestUrl({
			url,
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(
				`Falha ao listar arquivos do Drive (status ${response.status}): ${response.text}`
			);
		}

		return response.json.files ?? [];
	}

	/**
	 * Baixa um arquivo do Drive. Retorna:
	 * - { kind: "text", data: string } para markdown/texto/Google Docs (convertidos)
	 * - { kind: "binary", data: ArrayBuffer } para PDF/Word (anexados como estão)
	 * - null se o tipo não é suportado
	 */
	async downloadFileContent(accessToken, file) {
		let url;
		let isBinary = false;

		if (file.mimeType === GOOGLE_DOC_MIME_TYPE) {
			url = `${DRIVE_API}/files/${file.id}/export?mimeType=text/markdown`;
		} else if (PLAIN_TEXT_MIME_TYPES.has(file.mimeType)) {
			url = `${DRIVE_API}/files/${file.id}?alt=media`;
		} else if (BINARY_MIME_TYPES[file.mimeType]) {
			url = `${DRIVE_API}/files/${file.id}?alt=media`;
			isBinary = true;
		} else {
			return null;
		}

		const response = await requestUrl({
			url,
			method: "GET",
			headers: { Authorization: `Bearer ${accessToken}` },
			throw: false,
		});

		if (response.status !== 200) {
			throw new Error(
				`Falha ao baixar "${file.name}" (status ${response.status}): ${response.text}`
			);
		}

		return isBinary
			? { kind: "binary", data: response.arrayBuffer }
			: { kind: "text", data: response.text };
	}

	sanitizeFileName(name, extension) {
		const cleaned = name.replace(/[\\/:*?"<>|]/g, "-");
		const lower = cleaned.toLowerCase();
		return lower.endsWith(`.${extension}`) ? cleaned : `${cleaned}.${extension}`;
	}

	getTargetExtension(file) {
		if (file.mimeType === GOOGLE_DOC_MIME_TYPE || PLAIN_TEXT_MIME_TYPES.has(file.mimeType)) {
			return "md";
		}
		return BINARY_MIME_TYPES[file.mimeType] ?? "md";
	}

	async importFromDrive() {
		const notice = new Notice("Verificando o Google Drive...", 0);

		try {
			const accessToken = await this.getAccessToken();
			const files = await this.listDriveFiles(accessToken);

			const alreadyImported = new Set(this.settings.importedFileIds);
			const newFiles = files.filter((f) => !alreadyImported.has(f.id));

			if (newFiles.length === 0) {
				notice.setMessage("Nenhum arquivo novo encontrado.");
				setTimeout(() => notice.hide(), 3000);
				return;
			}

			let importedCount = 0;
			let skippedCount = 0;

			for (const file of newFiles) {
				notice.setMessage(`Importando "${file.name}"...`);

				const result = await this.downloadFileContent(accessToken, file);
				if (result === null) {
					skippedCount++;
					this.settings.importedFileIds.push(file.id);
					continue;
				}

				const targetFolder = this.settings.targetFolder?.trim();
				const extension = this.getTargetExtension(file);
				const fileName = this.sanitizeFileName(file.name, extension);
				const path = targetFolder ? `${targetFolder}/${fileName}` : fileName;

				const existing = this.app.vault.getAbstractFileByPath(path);
				if (existing) {
					skippedCount++;
					this.settings.importedFileIds.push(file.id);
					continue;
				}

				if (targetFolder && !this.app.vault.getAbstractFileByPath(targetFolder)) {
					await this.app.vault.createFolder(targetFolder);
				}

				if (result.kind === "binary") {
					await this.app.vault.createBinary(path, result.data);
				} else {
					await this.app.vault.create(path, result.data);
				}
				this.settings.importedFileIds.push(file.id);
				importedCount++;
			}

			await this.saveSettings();

			notice.setMessage(
				`Concluído: ${importedCount} importado(s), ${skippedCount} ignorado(s).`
			);
			setTimeout(() => notice.hide(), 5000);
		} catch (error) {
			console.error("Drive Importer:", error);
			notice.setMessage(`Erro: ${error.message}`);
			setTimeout(() => notice.hide(), 8000);
		}
	}
}

class DriveImporterSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Drive Importer" });
		containerEl.createEl("p", {
			text: "Importa arquivos criados manualmente no Google Drive (fora do Obsidian) para dentro do seu vault. Suporta: Markdown, texto puro, Google Docs (convertido), PDF e Word (anexados como estão).",
		});

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("Do Google Cloud Console (credenciais OAuth).")
			.addText((text) =>
				text
					.setPlaceholder("xxxxx.apps.googleusercontent.com")
					.setValue(this.plugin.settings.clientId)
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client secret")
			.setDesc("Do Google Cloud Console (credenciais OAuth).")
			.addText((text) => {
				text
					.setPlaceholder("GOCSPX-...")
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		containerEl.createEl("h3", { text: "1. Autorizar" });

		new Setting(containerEl)
			.setName("Abrir tela de autorização do Google")
			.setDesc(
				"Abre o navegador para você fazer login e autorizar. No final, uma página vai mostrar um código — copie ele."
			)
			.addButton((btn) =>
				btn.setButtonText("Abrir autorização").onClick(() => {
					if (!this.plugin.settings.clientId) {
						new Notice("Preencha o Client ID primeiro.");
						return;
					}
					window.open(this.plugin.buildAuthUrl(), "_blank");
				})
			);

		let codeValue = "";
		new Setting(containerEl)
			.setName("2. Colar o código de autorização")
			.setDesc("Cole aqui o código mostrado na página depois de autorizar.")
			.addText((text) =>
				text.setPlaceholder("4/0Axxxxxxxxxx").onChange((value) => {
					codeValue = value.trim();
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Trocar por refresh token").onClick(async () => {
					if (!codeValue) {
						new Notice("Cole o código primeiro.");
						return;
					}
					try {
						await this.plugin.exchangeCodeForRefreshToken(codeValue);
						new Notice("Refresh token obtido com sucesso!");
						this.display();
					} catch (error) {
						console.error(error);
						new Notice(`Erro: ${error.message}`, 8000);
					}
				})
			);

		new Setting(containerEl)
			.setName("Status da autorização")
			.setDesc(
				this.plugin.settings.refreshToken
					? "✅ Autorizado — refresh token salvo."
					: "❌ Ainda não autorizado."
			);

		containerEl.createEl("h3", { text: "2. Configurar a importação" });

		new Setting(containerEl)
			.setName("ID da pasta do Google Drive")
			.setDesc(
				"O ID que aparece na URL da pasta no Drive: drive.google.com/drive/folders/AQUI_ESTA_O_ID"
			)
			.addText((text) =>
				text
					.setPlaceholder("1AbCdEfGhIjKlMnOpQrStUvWxYz")
					.setValue(this.plugin.settings.driveFolderId)
					.onChange(async (value) => {
						this.plugin.settings.driveFolderId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pasta de destino no vault")
			.setDesc("Deixe em branco para importar na raiz do vault.")
			.addText((text) =>
				text
					.setPlaceholder("Importados")
					.setValue(this.plugin.settings.targetFolder)
					.onChange(async (value) => {
						this.plugin.settings.targetFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		containerEl.createEl("h3", { text: "3. Importar" });
		containerEl.createEl("p", {
			text: 'Use o comando "Importar novos arquivos do Google Drive" na paleta de comandos, ou clique no ícone de download na barra lateral.',
		});
	}
}

module.exports = DriveImporterPlugin;
