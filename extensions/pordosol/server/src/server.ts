import {
    createConnection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    ProposedFeatures,
    InitializeParams,
    DidChangeConfigurationNotification,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    TextDocumentSyncKind,
    InitializeResult,
    DocumentSymbol,
    DocumentSymbolParams,
    SymbolKind,
    SymbolInformation,
    WorkspaceSymbolParams,
    DefinitionParams,
    Location,
    ReferenceParams,
    PrepareRenameParams,
    RenameParams,
    WorkspaceEdit,
    TextDocumentEdit,
    TextEdit,
    DocumentFormattingParams,
    Range,
    TextDocumentChangeEvent,
    HoverParams,
    Hover,
    MarkupKind,
    Position,
    CodeActionKind,
    CodeActionParams,
    CodeAction,
    DocumentHighlightParams,
    DocumentHighlight,
    DocumentHighlightKind,
    FoldingRangeParams,
    FoldingRange,
    FoldingRangeKind,
    SemanticTokensParams,
    SemanticTokens,
    SemanticTokensBuilder
} from 'vscode-languageserver/node';
import {
    SignatureHelpParams,
    SignatureHelp,
    SignatureInformation,
    ParameterInformation
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let hasConfigurationCapability = false;
let hasWorkspaceFolderCapability = false;
let hasDiagnosticRelatedInformationCapability = false;

// Cache de bibliotecas .pbl carregadas
const libraryCache: Map<string, PblLibrary> = new Map();

interface PblLibrary {
    path: string;
    classes: Map<string, PblClass>;
    functions: Map<string, PblFunction>;
}

interface PblClass {
    name: string;
    fqn: string;
    methods: Map<string, PblMethod>;
    properties: Map<string, string>;
}

interface PblMethod {
    name: string;
    returnType: string;
    parameters: Array<{ name: string; type: string }>;
    isStatic: boolean;
    nativeKey?: string;
}

interface PblFunction {
    name: string;
    returnType: string;
    parameters: Array<{ name: string; type: string }>;
}

connection.onInitialize((params: InitializeParams) => {
    const capabilities = params.capabilities;

    hasConfigurationCapability = !!(

        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            documentSymbolProvider: false, // Temporariamente desabilitado devido a bug no range
            workspaceSymbolProvider: true,
            referencesProvider: true,
            renameProvider: true,
            documentFormattingProvider: true,
            documentHighlightProvider: true,
            foldingRangeProvider: true,
            codeActionProvider: {
                codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.Refactor]
            },
            semanticTokensProvider: {
                legend: {
                    tokenTypes: [
                        'namespace', 'type', 'class', 'interface', 'enum', 'typeParameter',
                        'function', 'method', 'decorator', 'macro', 'variable', 'parameter',
                        'property', 'enumMember', 'event', 'string', 'number', 'keyword',
                        'comment', 'operator', 'regexp'
                    ],
                    tokenModifiers: ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary']
                },
                full: true
            },
            diagnosticProvider: {
                interFileDependencies: false,
                workspaceDiagnostics: false
            },
            completionProvider: {
                resolveProvider: true,
                // adiciona ':' para sugerir após herança
                triggerCharacters: ['.', ' ', '(', '=', ':', 's', 'e', 'i', 't', 'b', 'c', 'f', 'n', '$', '{']
            },
            hoverProvider: true,
            signatureHelpProvider: {
                triggerCharacters: ['(', ',']
            }
        }
    };

    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Por Do Sol: Workspace folder change event received.');
        });
    }
});

interface PorDoSolSettings {
    maxNumberOfProblems: number;
    enableStrictMode: boolean;
    showWarnings: boolean;
    enableOwnershipAnalysis: boolean;
    stdlibPaths: string[];
}

const defaultSettings: PorDoSolSettings = {
    maxNumberOfProblems: 1000,
    enableStrictMode: true,
    showWarnings: true,
    enableOwnershipAnalysis: true,
    stdlibPaths: []
};
let globalSettings: PorDoSolSettings = defaultSettings;

const documentSettings: Map<string, Promise<PorDoSolSettings>> = new Map();

connection.onDidChangeConfiguration(change => {
    if (hasConfigurationCapability) {
        documentSettings.clear();
    } else {
        globalSettings = <PorDoSolSettings>(
            (change.settings.pordosolLanguageServer || defaultSettings)
        );
    }
    // Carregar bibliotecas configuradas
    loadConfiguredLibraries(globalSettings);
    documents.all().forEach(validateTextDocument);
});

function getDocumentSettings(resource: string): Promise<PorDoSolSettings> {
    if (!hasConfigurationCapability) {
        return Promise.resolve(globalSettings);
    }
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'pordosolLanguageServer'
        });
        documentSettings.set(resource, result);
    }
    return result;
}

documents.onDidClose(e => {
    documentSettings.delete(e.document.uri);
});

// Função para carregar bibliotecas .pbl
function loadPblLibrary(pblPath: string): PblLibrary | null {
    try {
        // Verificar se já está no cache
        if (libraryCache.has(pblPath)) {
            return libraryCache.get(pblPath)!;
        }

        // Ler o arquivo .pbl
        const content = fs.readFileSync(pblPath, 'utf-8');
        const library: PblLibrary = {
            path: pblPath,
            classes: new Map(),
            functions: new Map()
        };

        let inManifest = false;
        const lines = content.split(/\r?\n/);

        for (const line of lines) {
            const trimmed = line.trim();
            
            if (trimmed === '[MANIFESTO]') {
                inManifest = true;
                continue;
            }
            if (trimmed === '[BYTECODE]' || trimmed === '[PBL]') {
                inManifest = false;
                continue;
            }
            if (!inManifest || trimmed.startsWith(';') || trimmed.startsWith('#') || trimmed === '') {
                continue;
            }

            // Ignorar metadados de cabeçalho
            if (trimmed.includes('=') && !trimmed.startsWith('DEFINE') && !trimmed.startsWith('PROPERTY') && !trimmed.startsWith('FIELD')) {
                continue;
            }

            const parts = trimmed.split(/\s+/);
            if (parts.length === 0) continue;

            switch (parts[0]) {
                case 'DEFINE_CLASS': {
                    const fqn = parts[1];
                    const name = fqn.split('.').pop() || fqn;
                    const parent = parts[2] === 'NULO' ? undefined : parts[2];
                    
                    library.classes.set(fqn, {
                        name,
                        fqn,
                        methods: new Map(),
                        properties: new Map()
                    });
                    break;
                }
                case 'DEFINE_STATIC_CLASS': {
                    const fqn = parts[1];
                    const name = fqn.split('.').pop() || fqn;
                    
                    library.classes.set(fqn, {
                        name,
                        fqn,
                        methods: new Map(),
                        properties: new Map()
                    });
                    break;
                }
                case 'PROPERTY': {
                    const classFqn = parts[1];
                    const propName = parts[2];
                    const propType = parts[3];
                    
                    const cls = library.classes.get(classFqn);
                    if (cls) {
                        cls.properties.set(propName, propType);
                    }
                    break;
                }
                case 'DEFINE_METHOD':
                case 'DEFINE_STATIC_METHOD': {
                    const classFqn = parts[1];
                    const methodName = parts[2];
                    const returnType = parts[3];
                    const isStatic = parts[0] === 'DEFINE_STATIC_METHOD';
                    
                    const cls = library.classes.get(classFqn);
                    if (cls) {
                        cls.methods.set(methodName, {
                            name: methodName,
                            returnType,
                            parameters: [],
                            isStatic
                        });
                    }
                    break;
                }
                case 'DEFINE_FUNCTION': {
                    const funcName = parts[1];
                    const returnType = parts[2];
                    
                    library.functions.set(funcName, {
                        name: funcName,
                        returnType,
                        parameters: []
                    });
                    break;
                }
            }
        }

        // Adicionar ao cache
        libraryCache.set(pblPath, library);
        connection.console.log(`Por Do Sol: Biblioteca .pbl carregada: ${pblPath}`);
        return library;
    } catch (error) {
        connection.console.error(`Por Do Sol: Erro ao carregar biblioteca .pbl ${pblPath}: ${error}`);
        return null;
    }
}

// Carregar bibliotecas configuradas
function loadConfiguredLibraries(settings: PorDoSolSettings) {
    for (const libPath of settings.stdlibPaths) {
        if (fs.existsSync(libPath)) {
            loadPblLibrary(libPath);
        } else {
            connection.console.warn(`Por Do Sol: Caminho de biblioteca não encontrado: ${libPath}`);
        }
    }
}

// AUTOCOMPLETAR AVANÇADO COM ORIENTAÇÃO A OBJETOS
connection.onCompletion(
    (textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
        const document = documents.get(textDocumentPosition.textDocument.uri);
        if (!document) {
            return [];
        }

        const text = document.getText();
        const position = textDocumentPosition.position;
        const lineText = document.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line, character: position.character }
        });

        const completions: CompletionItem[] = [];

        // Palavras-chave principais expandidas
        const keywords = [
            {
                label: 'se',
                kind: CompletionItemKind.Keyword,
                insertText: 'se (${1:condicao}) {\n\t$2\n}',
                documentation: 'Estrutura condicional se-então-senão da linguagem Por Do Sol',
                detail: 'Condicional - Por Do Sol',
                data: 1
            },
            {
                label: 'senão',
                kind: CompletionItemKind.Keyword,
                insertText: 'senão {\n\t$1\n}',
                documentation: 'Bloco alternativo da estrutura se (linguagem Por Do Sol)',
                detail: 'Condicional alternativa',
                data: 11
            },
            {
                label: 'enquanto',
                kind: CompletionItemKind.Keyword,
                insertText: 'enquanto (${1:condicao}) {\n\t$2\n}',
                documentation: 'Loop enquanto condição for verdadeira na linguagem Por Do Sol',
                detail: 'Loop - Por Do Sol',
                data: 12
            },
            {
                label: 'para',
                kind: CompletionItemKind.Keyword,
                insertText: 'para (${1:inteiro i = 0}; ${2:i < 10}; ${3:i = i + 1}) {\n\t$4\n}',
                documentation: 'Loop for com inicialização, condição e incremento',
                detail: 'Loop For - Por Do Sol',
                data: 13
            },
            {
                label: 'imprima',
                kind: CompletionItemKind.Function,
                insertText: 'imprima(${1:valor});',
                documentation: 'função para imprimir valores na tela (linguagem Por Do Sol)',
                detail: 'função de saída - Por Do Sol',
                data: 14
            },
            {
                label: 'função',
                kind: CompletionItemKind.Keyword,
                insertText: 'função ${1:nome}(${2:parametros}) => ${3:tipo} {\n\t${4:// código}\n\tretorne ${5:valor};\n}',
                documentation: 'Declaração de função com tipo de retorno',
                detail: 'função - Por Do Sol',
                data: 3
            },
            {
                label: 'retorne',
                kind: CompletionItemKind.Keyword,
                insertText: 'retorne ${1:valor};',
                documentation: 'Retorna valor de uma função',
                detail: 'Return - Por Do Sol',
                data: 15
            },
            {
                label: 'var',
                kind: CompletionItemKind.Keyword,
                insertText: 'var ${1:nome} = ${2:valor};',
                documentation: 'Declaração com inferência de tipo',
                detail: 'Inferência de tipo - Por Do Sol',
                data: 16
            },
            {
                label: 'usando',
                kind: CompletionItemKind.Keyword,
                insertText: 'usando ${1:Namespace};',
                documentation: 'Importa tipos de um namespace (similar a using em C#)',
                detail: 'Import - Por Do Sol',
                data: 41
            }
        ];

        // Funções da biblioteca padrão - Matemáticas
        const mathFunctions = [
            {
                label: 'abs',
                kind: CompletionItemKind.Function,
                insertText: 'abs(${1:valor})',
                documentation: 'Retorna o valor absoluto de um número inteiro',
                detail: 'Função matemática - Por Do Sol',
                data: 50
            },
            {
                label: 'min',
                kind: CompletionItemKind.Function,
                insertText: 'min(${1:a}, ${2:b})',
                documentation: 'Retorna o menor de dois valores inteiros',
                detail: 'Função matemática - Por Do Sol',
                data: 51
            },
            {
                label: 'max',
                kind: CompletionItemKind.Function,
                insertText: 'max(${1:a}, ${2:b})',
                documentation: 'Retorna o maior de dois valores inteiros',
                detail: 'Função matemática - Por Do Sol',
                data: 52
            },
            {
                label: 'potencia',
                kind: CompletionItemKind.Function,
                insertText: 'potencia(${1:base}, ${2:expoente})',
                documentation: 'Calcula a potência de um número (base^expoente)',
                detail: 'Função matemática - Por Do Sol',
                data: 53
            },
            {
                label: 'raiz',
                kind: CompletionItemKind.Function,
                insertText: 'raiz(${1:valor})',
                documentation: 'Calcula a raiz quadrada de um número',
                detail: 'Função matemática - Por Do Sol',
                data: 54
            },
            {
                label: 'seno',
                kind: CompletionItemKind.Function,
                insertText: 'seno(${1:angulo})',
                documentation: 'Calcula o seno de um ângulo em radianos',
                detail: 'Função matemática - Por Do Sol',
                data: 55
            },
            {
                label: 'cosseno',
                kind: CompletionItemKind.Function,
                insertText: 'cosseno(${1:angulo})',
                documentation: 'Calcula o cosseno de um ângulo em radianos',
                detail: 'Função matemática - Por Do Sol',
                data: 56
            },
            {
                label: 'tangente',
                kind: CompletionItemKind.Function,
                insertText: 'tangente(${1:angulo})',
                documentation: 'Calcula a tangente de um ângulo em radianos',
                detail: 'Função matemática - Por Do Sol',
                data: 57
            },
            {
                label: 'logaritmo',
                kind: CompletionItemKind.Function,
                insertText: 'logaritmo(${1:valor})',
                documentation: 'Calcula o logaritmo natural de um número',
                detail: 'Função matemática - Por Do Sol',
                data: 58
            },
            {
                label: 'arredondar',
                kind: CompletionItemKind.Function,
                insertText: 'arredondar(${1:valor})',
                documentation: 'Arredonda um número para o inteiro mais próximo',
                detail: 'Função matemática - Por Do Sol',
                data: 59
            },
            {
                label: 'teto',
                kind: CompletionItemKind.Function,
                insertText: 'teto(${1:valor})',
                documentation: 'Arredonda um número para cima (ceil)',
                detail: 'Função matemática - Por Do Sol',
                data: 60
            },
            {
                label: 'piso',
                kind: CompletionItemKind.Function,
                insertText: 'piso(${1:valor})',
                documentation: 'Arredonda um número para baixo (floor)',
                detail: 'Função matemática - Por Do Sol',
                data: 61
            }
        ];

        // Funções da biblioteca padrão - String
        const stringFunctions = [
            {
                label: 'trecho',
                kind: CompletionItemKind.Function,
                insertText: 'trecho(${1:s}, ${2:inicio}, ${3:tamanho})',
                documentation: 'Extrai parte de uma string',
                detail: 'Função de string - Por Do Sol',
                data: 62
            },
            {
                label: 'para_maiusculo',
                kind: CompletionItemKind.Function,
                insertText: 'para_maiusculo(${1:s})',
                documentation: 'Converte uma string para maiúsculas',
                detail: 'Função de string - Por Do Sol',
                data: 63
            },
            {
                label: 'para_minusculo',
                kind: CompletionItemKind.Function,
                insertText: 'para_minusculo(${1:s})',
                documentation: 'Converte uma string para minúsculas',
                detail: 'Função de string - Por Do Sol',
                data: 64
            },
            {
                label: 'contem',
                kind: CompletionItemKind.Function,
                insertText: 'contem(${1:s}, ${2:busca})',
                documentation: 'Verifica se uma string contém outra substring',
                detail: 'Função de string - Por Do Sol',
                data: 65
            },
            {
                label: 'substituir',
                kind: CompletionItemKind.Function,
                insertText: 'substituir(${1:s}, ${2:antigo}, ${3:novo})',
                documentation: 'Substitui ocorrências de uma substring por outra',
                detail: 'Função de string - Por Do Sol',
                data: 66
            },
            {
                label: 'dividir',
                kind: CompletionItemKind.Function,
                insertText: 'dividir(${1:s}, ${2:delimitador})',
                documentation: 'Divide uma string em um array usando um delimitador',
                detail: 'Função de string - Por Do Sol',
                data: 67
            },
            {
                label: 'remover_espacos',
                kind: CompletionItemKind.Function,
                insertText: 'remover_espacos(${1:s})',
                documentation: 'Remove espaços extras do início e fim da string',
                detail: 'Função de string - Por Do Sol',
                data: 68
            }
        ];

        // Funções da biblioteca padrão - I/O
        const ioFunctions = [
            {
                label: 'EscreverLinha',
                kind: CompletionItemKind.Function,
                insertText: 'EscreverLinha(${1:texto});',
                documentation: 'Escreve uma linha de texto na saída padrão',
                detail: 'Função de I/O - Por Do Sol',
                data: 69
            },
            {
                label: 'LerLinha',
                kind: CompletionItemKind.Function,
                insertText: 'texto entrada = LerLinha();',
                documentation: 'Lê uma linha de texto da entrada padrão',
                detail: 'Função de I/O - Por Do Sol',
                data: 70
            }
        ];

        // Palavras-chave OOP CORRIGIDAS SEM PALAVRA CONSTRUTOR
        const oopKeywords = [
            {
                label: 'classe',
                kind: CompletionItemKind.Class,
                insertText: 'classe ${1:Nome} {\n\t${2:público} ${3:inteiro} ${4:propriedade};\n\n\t${1:Nome}(${5:parametros}) {\n\t\t${6:// inicialização}\n\t}\n\n\t${2:público} ${7:vazio} ${8:metodo}() {\n\t\t${9:// código}\n\t}\n}',
                documentation: 'Declaração de classe com propriedades e métodos (sem palavra construtor)',
                detail: 'Classe - Por Do Sol',
                data: 2
            },
            {
                label: 'construtor',
                kind: CompletionItemKind.Constructor,
                insertText: '${1:NomeClasse}(${2:parametros}) {\n\t${3:// inicialização}\n}',
                documentation: 'Método construtor da classe (apenas nome da classe)',
                detail: 'Construtor - Por Do Sol',
                data: 17
            },
            {
                label: 'este',
                kind: CompletionItemKind.Keyword,
                insertText: 'este.',
                documentation: 'Referência à instância atual do objeto (this)',
                detail: 'Referência - Por Do Sol',
                data: 18
            },
            {
                label: 'novo',
                kind: CompletionItemKind.Keyword,
                insertText: 'novo ${1:Classe}(${2:argumentos})',
                documentation: 'Criação de nova instância de classe',
                detail: 'Instanciação - Por Do Sol',
                data: 19
            },
            {
                label: 'nova',
                kind: CompletionItemKind.Keyword,
                insertText: 'nova ${1:Classe}(${2:argumentos})',
                documentation: 'Criação de nova instância de classe (forma feminina)',
                detail: 'Instanciação - Por Do Sol',
                data: 20
            },
            {
                label: 'espaco',
                kind: CompletionItemKind.Module,
                insertText: 'espaco ${1:Nome} {\n\t${2:// conteúdo}\n}',
                documentation: 'Declaração de namespace/módulo',
                detail: 'Namespace - Por Do Sol',
                data: 21
            },
            {
                label: '[Nativo]',
                kind: CompletionItemKind.Snippet,
                insertText: '[Nativo]("${1:Namespace::Metodo}")',
                documentation: 'Atributo para marcar métodos que chamam código nativo do runtime',
                detail: 'Atributo Nativo - Por Do Sol',
                data: 72
            }
        ];

        // Snippets avançados para uso da stdlib
        const stdlibSnippets = [
            {
                label: 'Sistema.Console',
                kind: CompletionItemKind.Snippet,
                insertText: 'usando Sistema.Console;\n\nEscreverLinha("${1:mensagem}");',
                documentation: 'Snippet para usar Sistema.Console e EscreverLinha',
                detail: 'Sistema.Console - Por Do Sol',
                data: 73
            },
            {
                label: 'classe Console',
                kind: CompletionItemKind.Snippet,
                insertText: 'classe Console {\n\t[Nativo]("Console::EscreverLinha")\n\tpúblico estatica externo vazio EscreverLinha(texto mensagem);\n\n\t[Nativo]("Console::LerLinha")\n\tpúblico estatica externo texto LerLinha();\n}',
                documentation: 'Declaração de classe Console com métodos nativos (sintaxe sistema-padrao)',
                detail: 'Classe Console - Por Do Sol',
                data: 74
            },
            {
                label: 'classe Arquivo',
                kind: CompletionItemKind.Snippet,
                insertText: 'classe Arquivo {\n\t[Nativo]("Arquivo::LerTexto")\n\tpúblico estatica externo texto LerTexto(texto caminho);\n\n\t[Nativo]("Arquivo::EscreverTexto")\n\tpúblico estatica externo vazio EscreverTexto(texto caminho, texto conteudo);\n}',
                documentation: 'Declaração de classe Arquivo com métodos nativos (sintaxe sistema-padrao)',
                detail: 'Classe Arquivo - Por Do Sol',
                data: 75
            },
            {
                label: 'função matemática',
                kind: CompletionItemKind.Snippet,
                insertText: 'função ${1:nome}(${2:parametros}) => ${3:tipo} {\n\t${4:// corpo usando funções matemáticas}\n\tretorne ${5:resultado};\n}',
                documentation: 'Snippet para função matemática usando stdlib',
                detail: 'Função Matemática - Por Do Sol',
                data: 76
            },
            {
                label: 'processamento string',
                kind: CompletionItemKind.Snippet,
                insertText: 'texto ${1:resultado} = ${2:para_maiusculo|para_minusculo|trecho|contem|substituir|dividir|remover_espacos}(${3:texto});',
                documentation: 'Snippet para processamento de strings',
                detail: 'Processamento String - Por Do Sol',
                data: 77
            },
            {
                label: 'novo array',
                kind: CompletionItemKind.Snippet,
                insertText: 'novo ${1:Tipo}[${2:tamanho}]',
                documentation: 'Cria um novo array com tamanho fixo',
                detail: 'Array - Por Do Sol',
                data: 78
            },
            {
                label: 'nova lista',
                kind: CompletionItemKind.Snippet,
                insertText: 'novo ${1:Tipo}[]',
                documentation: 'Cria uma nova lista (array dinâmico)',
                detail: 'Lista - Por Do Sol',
                data: 79
            },
            {
                label: 'propriedade com corpo',
                kind: CompletionItemKind.Snippet,
                insertText: 'público ${1:tipo} ${2:Nome} {\n\tobter {\n\t\tretorne ${3:valor};\n\t}\n\tdefinir {\n\t\t${4:campo} = valor;\n\t}\n}',
                documentation: 'Propriedade com getters e setters',
                detail: 'Propriedade - Por Do Sol',
                data: 80
            }
        ];

        // Modificadores de acesso
        const accessModifiers = [
            {
                label: 'público',
                kind: CompletionItemKind.Keyword,
                insertText: 'público ',
                documentation: 'Modificador de acesso público',
                detail: 'Acesso - Por Do Sol',
                data: 80
            },
            {
                label: 'publico',
                kind: CompletionItemKind.Keyword,
                insertText: 'publico ',
                documentation: 'Modificador de acesso público (sem acento)',
                detail: 'Acesso - Por Do Sol',
                data: 81
            },
            {
                label: 'privado',
                kind: CompletionItemKind.Keyword,
                insertText: 'privado ',
                documentation: 'Modificador de acesso privado',
                detail: 'Acesso - Por Do Sol',
                data: 82
            },
            {
                label: 'protegido',
                kind: CompletionItemKind.Keyword,
                insertText: 'protegido ',
                documentation: 'Modificador de acesso protegido',
                detail: 'Acesso - Por Do Sol',
                data: 83
            },
            {
                label: 'estática',
                kind: CompletionItemKind.Keyword,
                insertText: 'estática ',
                documentation: 'Modificador para membros estáticos da classe',
                detail: 'Modificador estático - Por Do Sol',
                data: 84
            },
            {
                label: 'sobrescreve',
                kind: CompletionItemKind.Keyword,
                insertText: 'sobrescreve ',
                documentation: 'Modificador para sobrescrever um membro redefinível (override)',
                detail: 'Modificador de Sobrescrita - Por Do Sol',
                data: 85
            },
            {
                label: 'redefinível',
                kind: CompletionItemKind.Keyword,
                insertText: 'redefinível ',
                documentation: 'Modificador para permitir que um membro seja sobrescrito em classes derivadas (virtual)',
                detail: 'Modificador Redefinível - Por Do Sol',
                data: 86
            },
            {
                label: 'abstrata',
                kind: CompletionItemKind.Keyword,
                insertText: 'abstrata ',
                documentation: 'Define classe ou método abstrato que deve ser implementado por classes derivadas',
                detail: 'Modificador Abstrato - Por Do Sol',
                data: 87
            },
            {
                label: 'assíncrono',
                kind: CompletionItemKind.Keyword,
                insertText: 'assíncrono ',
                documentation: 'Modificador para funções assíncronas (async)',
                detail: 'Modificador Assíncrono - Por Do Sol',
                data: 88
            },
            {
                label: 'aguarde',
                kind: CompletionItemKind.Keyword,
                insertText: 'aguarde ',
                documentation: 'Palavra-chave await para aguardar resultado de operação assíncrona',
                detail: 'Await - Por Do Sol',
                data: 89
            }
        ];

        // Tipos de dados expandidos
        const types = [
            {
                label: 'inteiro',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'inteiro ${1:nome} = ${2:0};',
                documentation: 'Tipo de dados para números inteiros de 64 bits',
                detail: 'Tipo de dados - Por Do Sol',
                data: 90
            },
            {
                label: 'texto',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'texto ${1:nome} = "${2:valor}";',
                documentation: 'Tipo de dados para strings de texto',
                detail: 'Tipo de dados - Por Do Sol',
                data: 91
            },
            {
                label: 'booleano',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'booleano ${1:nome} = ${2|verdadeiro,falso|};',
                documentation: 'Tipo de dados lógico verdadeiro/falso',
                detail: 'Tipo de dados - Por Do Sol',
                data: 92
            },
            {
                label: 'vazio',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'vazio',
                documentation: 'Tipo void para funções que não retornam valor',
                detail: 'Tipo de dados - Por Do Sol',
                data: 93
            },
            {
                label: 'objeto',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'objeto',
                documentation: 'Tipo base para objetos não tipados',
                detail: 'Tipo de dados - Por Do Sol',
                data: 94
            },
            {
                label: 'nulo',
                kind: CompletionItemKind.Keyword,
                insertText: 'nulo',
                documentation: 'Literal nulo, representa ausência de valor',
                detail: 'Literal - Por Do Sol',
                data: 95
            },
            {
                label: 'externo',
                kind: CompletionItemKind.Keyword,
                insertText: 'externo',
                documentation: 'Palavra-chave para métodos externos (sem implementação no Por Do Sol)',
                detail: 'Modificador - Por Do Sol',
                data: 96
            },
            {
                label: 'decimal',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'decimal ${1:nome} = ${2:0.0m};',
                documentation: 'Tipo de dados para números decimais de alta precisão, similar ao C#',
                detail: 'Tipo de dados decimal - Por Do Sol',
                data: 97
            },
            {
                label: 'duplo',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'duplo ${1:nome} = ${2:0.0};',
                documentation: 'Tipo de ponto flutuante de dupla precisão (64 bits), equivalente a double',
                detail: 'Tipo de dados - Por Do Sol',
                data: 98
            },
            {
                label: 'flutuante',
                kind: CompletionItemKind.TypeParameter,
                insertText: 'flutuante ${1:nome} = ${2:0.0f};',
                documentation: 'Tipo de ponto flutuante de precisão simples (32 bits), equivalente a float',
                detail: 'Tipo de dados - Por Do Sol',
                data: 99
            }
        ];

        // Valores e literais
        const values = [
            {
                label: 'verdadeiro',
                kind: CompletionItemKind.Value,
                insertText: 'verdadeiro',
                documentation: 'Valor booleano verdadeiro',
                detail: 'Valor booleano',
                data: 100
            },
            {
                label: 'falso',
                kind: CompletionItemKind.Value,
                insertText: 'falso',
                documentation: 'Valor booleano falso',
                detail: 'Valor booleano',
                data: 101
            }
        ];

        // Interpolação de strings
        if (lineText.includes('$"') || lineText.includes('${')) {
            completions.push(...getVariableNames(text));
            return completions;
        }

        // Contexto de classe
        if (isInsideClass(text, position)) {
            completions.push(...accessModifiers, ...types, ...oopKeywords.slice(1)); // Excluir 'classe'
        }

        // Contexto após 'novo' ou 'nova'
        if (lineText.includes('novo ') || lineText.includes('nova ')) {
            completions.push(...getClassNames(text));
        }

        // Contexto após 'este.'
        if (lineText.includes('este.')) {
            completions.push(...getClassMembers(text, position));
        }

        // Contexto geral
        if (lineText.trim().length === 0) {
            completions.push(...keywords, ...oopKeywords, ...types, ...mathFunctions, ...stringFunctions, ...ioFunctions);
            completions.push(...getLibraryCompletions());
            completions.push(...stdlibSnippets);
        } else if (lineText.includes('=') && !lineText.includes('==')) {
            completions.push(...values, ...getVariableNames(text), ...mathFunctions, ...stringFunctions);
        } else {
            completions.push(...keywords, ...oopKeywords, ...types, ...mathFunctions, ...stringFunctions, ...ioFunctions);
            completions.push(...getLibraryCompletions());
            completions.push(...stdlibSnippets);
        }

        return completions;
    }
);

// HANDLER PARA RESOLUÇÃO DE COMPLETION ITEMS - CORRIGIDO
connection.onCompletionResolve(
    (item: CompletionItem): CompletionItem => {
        // Verificar se o item tem dados para resolver
        if (item.data === 1) {
            item.detail = 'Condicional Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Estrutura condicional**

\`\`\`
se (condicao) 
{
    // código
}
\`\`\`

Executa código baseado em uma condição lógica.`
            };
        } else if (item.data === 2) {
            item.detail = 'Classe Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Orientação a Objetos**

\`\`\`
classe MinhaClasse 
{
    público inteiro propriedade;
    
    MinhaClasse(parametros) 
    {
        // inicialização sem palavra construtor
    }
    
    público vazio metodo() 
    {
        // código do método
    }
}
\`\`\``
            };
        } else if (item.data === 3) {
            item.detail = 'função Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Declaração de função**

\`\`\`
função minhaFunção() => inteiro 
{
    retorne 42;
}
\`\`\``
            };
        } else if (item.data === 11) {
            item.detail = 'Senão - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Bloco alternativo**

\`\`\`
se (condicao) 
{
    // código verdadeiro
} 
senão 
{
    // código falso
}
\`\`\``
            };
        } else if (item.data === 12) {
            item.detail = 'Loop Enquanto - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Loop enquanto**

\`\`\`
enquanto (condicao) 
{
    // código repetitivo
}
\`\`\``
            };
        } else if (item.data === 13) {
            item.detail = 'Loop Para - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Loop for**

\`\`\`
para (inteiro i = 0; i < 10; i = i + 1) 
{
    // código repetitivo
}
\`\`\``
            };
        } else if (item.data === 17) {
            item.detail = 'Construtor - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Método Construtor**

\`\`\`
NomeClasse(parametros) 
{
    // inicialização
    // Sem palavra-chave 'construtor'
}
\`\`\`

O construtor é declarado apenas com o nome da classe.`
            };
        } else if (item.data === 18) {
            item.detail = 'Referência Este - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Referência ao objeto atual**

Usado para acessar propriedades e métodos da instância atual.

\`\`\`
este.propriedade = valor;
este.metodo();
\`\`\``
            };
        } else if (item.data === 19) {
            item.detail = 'Instanciação - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Criação de objeto**

\`\`\`
var objeto = novo MinhaClasse(argumentos);
\`\`\``
            };
        } else if (item.data === 20) {
            item.detail = 'Namespace - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Organização modular**

\`\`\`
espaco MeuNamespace 
{
    classe MinhaClasse { }
}
\`\`\``
            };
        } else if (item.data === 50) {
            item.detail = 'Função abs - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Valor absoluto**

Retorna o valor absoluto de um número inteiro.

\`\`\`
inteiro resultado = abs(-42); // retorna 42
\`\`\``
            };
        } else if (item.data === 51) {
            item.detail = 'Função min - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Menor valor**

Retorna o menor de dois valores inteiros.

\`\`\`
inteiro resultado = min(10, 5); // retorna 5
\`\`\``
            };
        } else if (item.data === 52) {
            item.detail = 'Função max - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Maior valor**

Retorna o maior de dois valores inteiros.

\`\`\`
inteiro resultado = max(10, 5); // retorna 10
\`\`\``
            };
        } else if (item.data === 53) {
            item.detail = 'Função potencia - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Potência**

Calcula a potência de um número.

\`\`\`
duplo resultado = potencia(2, 3); // retorna 8.0
\`\`\``
            };
        } else if (item.data === 54) {
            item.detail = 'Função raiz - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Raiz quadrada**

Calcula a raiz quadrada de um número.

\`\`\`
duplo resultado = raiz(16); // retorna 4.0
\`\`\``
            };
        } else if (item.data === 55) {
            item.detail = 'Função seno - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Seno**

Calcula o seno de um ângulo em radianos.

\`\`\`
duplo resultado = seno(3.14159 / 2); // retorna aproximadamente 1.0
\`\`\``
            };
        } else if (item.data === 56) {
            item.detail = 'Função cosseno - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Cosseno**

Calcula o cosseno de um ângulo em radianos.

\`\`\`
duplo resultado = cosseno(0); // retorna 1.0
\`\`\``
            };
        } else if (item.data === 57) {
            item.detail = 'Função tangente - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Tangente**

Calcula a tangente de um ângulo em radianos.

\`\`\`
duplo resultado = tangente(3.14159 / 4); // retorna aproximadamente 1.0
\`\`\``
            };
        } else if (item.data === 58) {
            item.detail = 'Função logaritmo - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Logaritmo natural**

Calcula o logaritmo natural de um número.

\`\`\`
duplo resultado = logaritmo(2.71828); // retorna aproximadamente 1.0
\`\`\``
            };
        } else if (item.data === 59) {
            item.detail = 'Função arredondar - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Arredondar**

Arredonda um número para o inteiro mais próximo.

\`\`\`
duplo resultado = arredondar(3.7); // retorna 4.0
\`\`\``
            };
        } else if (item.data === 60) {
            item.detail = 'Função teto - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Teto (Ceil)**

Arredonda um número para cima.

\`\`\`
duplo resultado = teto(3.2); // retorna 4.0
\`\`\``
            };
        } else if (item.data === 61) {
            item.detail = 'Função piso - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Piso (Floor)**

Arredonda um número para baixo.

\`\`\`
duplo resultado = piso(3.8); // retorna 3.0
\`\`\``
            };
        } else if (item.data === 62) {
            item.detail = 'Função trecho - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Trecho**

Extrai parte de uma string.

\`\`\`
texto s = "Olá Mundo";
texto parte = trecho(s, 0, 3); // retorna "Olá"
\`\`\``
            };
        } else if (item.data === 63) {
            item.detail = 'Função para_maiusculo - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Para maiúsculo**

Converte uma string para maiúsculas.

\`\`\`
texto s = "olá";
texto resultado = para_maiusculo(s); // retorna "OLÁ"
\`\`\``
            };
        } else if (item.data === 64) {
            item.detail = 'Função para_minusculo - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Para minúsculo**

Converte uma string para minúsculas.

\`\`\`
texto s = "OLÁ";
texto resultado = para_minusculo(s); // retorna "olá"
\`\`\``
            };
        } else if (item.data === 65) {
            item.detail = 'Função contem - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Contém**

Verifica se uma string contém outra substring.

\`\`\`
texto s = "Olá Mundo";
booleano resultado = contem(s, "Mundo"); // retorna verdadeiro
\`\`\``
            };
        } else if (item.data === 66) {
            item.detail = 'Função substituir - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Substituir**

Substitui ocorrências de uma substring por outra.

\`\`\`
texto s = "Olá Mundo";
texto resultado = substituir(s, "Mundo", "Brasil"); // retorna "Olá Brasil"
\`\`\``
            };
        } else if (item.data === 67) {
            item.detail = 'Função dividir - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Dividir**

Divide uma string em um array usando um delimitador.

\`\`\`
texto s = "a,b,c";
// retorna array ["a", "b", "c"]
\`\`\``
            };
        } else if (item.data === 68) {
            item.detail = 'Função remover_espacos - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Remover espaços**

Remove espaços extras do início e fim da string.

\`\`\`
texto s = "  Olá  ";
texto resultado = remover_espacos(s); // retorna "Olá"
\`\`\``
            };
        } else if (item.data === 69) {
            item.detail = 'Função EscreverLinha - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Escrever linha**

Escreve uma linha de texto na saída padrão.

\`\`\`
EscreverLinha("Olá, Mundo!");
\`\`\``
            };
        } else if (item.data === 70) {
            item.detail = 'Função LerLinha - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Ler linha**

Lê uma linha de texto da entrada padrão.

\`\`\`
texto entrada = LerLinha();
\`\`\``
            };
        } else if (item.data === 71) {
            item.detail = 'Atributo [Nativo] - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Atributo [Nativo]**

Marca métodos que chamam código nativo do runtime.

\`\`\`
[Nativo]("Sistema::Console::EscreverLinha")
público vazio EscreverLinha(texto mensagem);
\`\`\`

Use este atributo para métodos que são implementados em Rust no runtime.`
            };
        } else if (item.data === 72) {
            item.detail = 'Sistema.Console - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Sistema.Console**

Snippet para usar Sistema.Console e EscreverLinha.

\`\`\`
usando Sistema.Console;

EscreverLinha("Olá, Mundo!");
\`\`\``
            };
        } else if (item.data === 73) {
            item.detail = 'Classe Console - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Classe Console**

Declaração de classe Console com métodos nativos.

\`\`\`
classe Console {
    [Nativo]("Console::EscreverLinha")
    público estatica vazio EscreverLinha(texto mensagem);

    [Nativo]("Console::LerLinha")
    público estatica texto LerLinha();
}
\`\`\``
            };
        } else if (item.data === 74) {
            item.detail = 'Classe Arquivo - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Classe Arquivo**

Declaração de classe Arquivo com métodos nativos.

\`\`\`
classe Arquivo {
    [Nativo]("Arquivo::LerTudo")
    público texto LerTudo(texto caminho);

    [Nativo]("Arquivo::Escrever")
    público vazio Escrever(texto caminho, texto conteudo);
}
\`\`\``
            };
        } else if (item.data === 75) {
            item.detail = 'Função Matemática - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Função Matemática**

Snippet para função matemática usando stdlib.

\`\`\`
função calcularArea(raio) => duplo {
    duplo area = 3.14159 * potencia(raio, 2);
    retorne area;
}
\`\`\``
            };
        } else if (item.data === 76) {
            item.detail = 'Processamento String - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Processamento String**

Snippet para processamento de strings.

\`\`\`
texto resultado = para_maiusculo(texto);
texto parte = trecho(texto, 0, 5);
booleano contem = contem(texto, "busca");
\`\`\``
            };
        } else if (item.data === 77) {
            item.detail = 'Array - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Novo Array**

Cria um novo array com tamanho fixo.

\`\`\`
inteiro[] numeros = novo inteiro[10];
texto[] nomes = novo texto[5];
\`\`\``
            };
        } else if (item.data === 78) {
            item.detail = 'Lista - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Nova Lista**

Cria uma nova lista (array dinâmico).

\`\`\`
Lista<inteiro> numeros = novo inteiro[];
Lista<texto> nomes = novo texto[];
\`\`\``
            };
        } else if (item.data === 79) {
            item.detail = 'Propriedade - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Propriedade com Corpo**

Propriedade com getters e setters.

\`\`\`
público inteiro Idade {
    obter {
        retorne _idade;
    }
    definir {
        _idade = valor;
    }
}
\`\`\``
            };
        } else if (item.data === 80) {
            item.detail = 'Atributo [Nativo] - Por Do Sol';
            item.documentation = {
                kind: MarkupKind.Markdown,
                value: `**Atributo [Nativo]**

Marca métodos que chamam código nativo do runtime (sintaxe usada na biblioteca padrão sistema-padrao).

\`\`\`
[Nativo]("Console::EscreverLinha")
público estatica externo vazio EscreverLinha(texto mensagem);
\`\`\`

Use esta sintaxe nos arquivos da biblioteca padrão.`
            };
        }

        return item;
    }
);

// Função para obter completions de bibliotecas carregadas
function getLibraryCompletions(): CompletionItem[] {
    const completions: CompletionItem[] = [];
    
    for (const [path, library] of libraryCache) {
        // Adicionar classes
        for (const [fqn, cls] of library.classes) {
            completions.push({
                label: cls.name,
                kind: CompletionItemKind.Class,
                insertText: cls.name,
                documentation: `Classe da biblioteca: ${fqn}`,
                detail: `Biblioteca: ${path}`,
                data: 80
            });
            
            // Adicionar métodos da classe
            for (const [methodName, method] of cls.methods) {
                completions.push({
                    label: `${cls.name}.${methodName}`,
                    kind: CompletionItemKind.Method,
                    insertText: `${cls.name}.${methodName}($1)`,
                    documentation: `Método ${method.returnType} ${methodName}`,
                    detail: `Classe: ${fqn}`,
                    data: 81
                });
            }
        }
        
        // Adicionar funções globais
        for (const [funcName, func] of library.functions) {
            completions.push({
                label: funcName,
                kind: CompletionItemKind.Function,
                insertText: `${funcName}($1)`,
                documentation: `Função ${func.returnType} ${funcName}`,
                detail: `Biblioteca: ${path}`,
                data: 82
            });
        }
    }
    
    return completions;
}

// Funções auxiliares expandidas
function getVariableNames(text: string): CompletionItem[] {
    const variableRegex = /(?:inteiro|texto|booleano|duplo|flutuante|decimal|var)\s+(\w+)/g;
    const variables: CompletionItem[] = [];
    let match;

    while ((match = variableRegex.exec(text)) !== null) {
        variables.push({
            label: match[1],
            kind: CompletionItemKind.Variable,
            insertText: match[1],
            documentation: `Variável declarada: ${match[1]}`,
            detail: 'Variável - Por Do Sol',
            data: 100 + variables.length
        });
    }

    return variables;
}

function getClassNames(text: string): CompletionItem[] {
    const classRegex = /classe\s+(\w+)/g;
    const classes: CompletionItem[] = [];
    let match;

    while ((match = classRegex.exec(text)) !== null) {
        classes.push({
            label: match[1],
            kind: CompletionItemKind.Class,
            insertText: match[1],
            documentation: `Classe: ${match[1]}`,
            detail: 'Classe - Por Do Sol',
            data: 200 + classes.length
        });
    }

    return classes;
}

function isInsideClass(text: string, position: Position): boolean {
    const lines = text.split('\n');
    let insideClass = false;
    let braceCount = 0;

    for (let i = 0; i <= position.line; i++) {
        const line = lines[i];
        if (line.includes('classe ')) {
            insideClass = true;
            braceCount = 0;
        }

        for (const char of line) {
            if (char === '{') braceCount++;
            if (char === '}') braceCount--;
        }

        if (insideClass && braceCount === 0 && i > 0) {
            insideClass = false;
        }
    }

    return insideClass && braceCount > 0;
}

function getClassMembers(text: string, position: Position): CompletionItem[] {
    const completions: CompletionItem[] = [];
    const symbols = buildDocumentSymbols(text);

    // Encontra a classe que contém a posição
    const cls = findEnclosingClass(symbols, position);
    if (cls) {
        const children = cls.children || [];
        for (const c of children) {
            if (c.kind === SymbolKind.Method) {
                completions.push({
                    label: c.name,
                    kind: CompletionItemKind.Method,
                    insertText: `${c.name}($1)`
                });
            } else if (c.kind === SymbolKind.Property) {
                completions.push({
                    label: c.name,
                    kind: CompletionItemKind.Property,
                    insertText: c.name
                });
            }
        }
    }

    // Heurística: se linha contém VARIAVEL., tentar deduzir tipo básico e sugerir membros da classe correspondente
    const lineStart = { line: position.line, character: 0 };
    const lineEnd = { line: position.line + 1, character: 0 };
    const lineText = documents.get(Array.from(documents.keys())[0] || '') ? '' : '';
    // Como não temos acesso direto ao documento aqui, mantemos apenas membros de 'este.' via classe atual.
    // Futuro: ampliar para resolver tipos de variáveis (var x = novo Classe();) e sugerir membros de Classe.

    return completions;
}

// VALIDAÇÃO EXPANDIDA - Função para calcular diagnósticos (reutilizável)
async function computeDiagnostics(textDocument: TextDocument): Promise<Diagnostic[]> {
    const settings = await getDocumentSettings(textDocument.uri);
    const text = textDocument.getText();
    const diagnostics: Diagnostic[] = [];
    const lines = text.split('\n');

    lines.forEach((line: string, index: number) => {
        const trimmed = line.trim();

        // Pular linhas vazias e comentários
        if (!trimmed || trimmed.startsWith('//')) {
            return;
        }

        // CONTEXTO: Verificar se estamos dentro de uma assinatura de método/construtor
        const isInsideMethodSignature = (lineIndex: number): boolean => {
            // Procurar para trás por uma linha que indica início de método/construtor
            for (let i = lineIndex; i >= 0; i--) {
                const prevLine = lines[i].trim();

                // Se encontrou uma abertura de chaves, não estamos em assinatura
                if (prevLine.endsWith('{')) {
                    return false;
                }

                // Se encontrou início de construtor ou função
                if (prevLine.match(/^(público|publico|privado|protegido)?\s*(função\s+\w+|[A-Z]\w*)\s*\(/)) {
                    return true;
                }

                // Se a linha atual ou anterior tem parênteses abertos sem fechar
                if (prevLine.includes('(') && !prevLine.includes(')')) {
                    return true;
                }
            }
            return false;
        };

        // CONTEXTO: Verificar se estamos dentro de propriedades { obter; definir; }
        const isInsidePropertyBlock = (lineIndex: number): boolean => {
            const currentLine = lines[lineIndex].trim();
            return currentLine.includes('{ obter; definir; }') ||
                currentLine.includes('{') && currentLine.includes('obter') ||
                currentLine.includes('{') && currentLine.includes('definir');
        };

        // Verificar se é uma linha que claramente deve terminar com ;
        const shouldEndWithSemicolon = (
            // Comando imprima completo em uma linha
            (trimmed.includes('imprima(') && trimmed.includes(')') && !trimmed.endsWith(';')) ||

            // Declaração de variável simples (uma linha só) - MAS NÃO dentro de assinatura
            (trimmed.match(/^(inteiro|texto|booleano|var)\s+\w+\s*=\s*[^,\n(]+$/) &&
                !trimmed.endsWith(';') &&
                !isInsideMethodSignature(index)) ||

            // Atribuição simples (uma linha só) - MAS NÃO dentro de assinatura
            (trimmed.match(/^\w+\s*=\s*[^,\n(]+$/) &&
                !trimmed.endsWith(';') &&
                !isInsideMethodSignature(index)) ||

            // Chamada de função simples (uma linha só)
            (trimmed.match(/^\w+\.\w+\([^)]*\)$/) && !trimmed.endsWith(';'))
        );

        // NÃO VALIDAR se:
        const isClassDecl = /^(público|publico|privado|protegido)?\s*(abstrata\s+)?classe\b/.test(trimmed);
        const skipValidation = (
            isInsideMethodSignature(index) ||           // Dentro de assinatura de método
            isInsidePropertyBlock(index) ||             // Dentro de bloco de propriedades
            trimmed.endsWith('{') ||                    // Linha termina com abertura de chave
            trimmed.endsWith('}') ||                    // Linha termina com fechamento de chave
            trimmed.endsWith(',') ||                    // Linha termina com vírgula (parâmetro continua)
            trimmed.endsWith(')') ||                    // Linha termina com parênteses (fim de parâmetros)
            isClassDecl ||                               // Declaração de classe (inclui abstrata)
            trimmed.includes('espaco ') ||              // Declaração de namespace
            trimmed.match(/^(público|publico|privado|protegido)\s+(inteiro|texto|booleano|duplo|flutuante|decimal)\s+\w+\s*{/) // Propriedade com getter/setter
        );

        if (shouldEndWithSemicolon && !skipValidation) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: index, character: 0 },
                    end: { line: index, character: line.length }
                },
                message: 'Comando deve terminar com ponto e vírgula (;)',
                source: 'Por Do Sol Language Server',
                code: 'missing-semicolon'
            });
        }

        // Validação de interpolação de strings
        if (trimmed.includes('$"')) {
            const interpolationRegex = /\$"[^"]*\{[^}]*\}[^"]*"/g;
            if (!interpolationRegex.test(trimmed) && trimmed.includes('{')) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: index, character: trimmed.indexOf('$"') },
                        end: { line: index, character: line.length }
                    },
                    message: 'Interpolação de string mal formada - use $"texto {variavel}"',
                    source: 'Por Do Sol Language Server',
                    code: 'malformed-interpolation'
                });
            }
        }

        // Validação do atributo [Nativo] (sintaxe atual do compilador)
        if (trimmed.includes('[Nativo')) {
            const colcheteRegex = /\[Nativo\("([^"]+)"\)\]/;
            const colcheteMatch = trimmed.match(colcheteRegex);
            
            if (!colcheteMatch) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: {
                        start: { line: index, character: trimmed.indexOf('[Nativo') },
                        end: { line: index, character: line.length }
                    },
                    message: 'Sintaxe do atributo Nativo incorreta - use [Nativo("Namespace::Metodo")]',
                    source: 'Por Do Sol Language Server',
                    code: 'malformed-nativo-attribute'
                });
            }
        }

        // Validação de chamadas de funções da stdlib
        const stdlibFunctions = [
            { name: 'abs', params: 1 },
            { name: 'min', params: 2 },
            { name: 'max', params: 2 },
            { name: 'potencia', params: 2 },
            { name: 'raiz', params: 1 },
            { name: 'seno', params: 1 },
            { name: 'cosseno', params: 1 },
            { name: 'tangente', params: 1 },
            { name: 'logaritmo', params: 1 },
            { name: 'arredondar', params: 1 },
            { name: 'teto', params: 1 },
            { name: 'piso', params: 1 },
            { name: 'trecho', params: 3 },
            { name: 'para_maiusculo', params: 1 },
            { name: 'para_minusculo', params: 1 },
            { name: 'contem', params: 2 },
            { name: 'substituir', params: 3 },
            { name: 'dividir', params: 2 },
            { name: 'remover_espacos', params: 1 },
            { name: 'EscreverLinha', params: 1 },
            { name: 'LerLinha', params: 0 }
        ];

        for (const func of stdlibFunctions) {
            const funcCallRegex = new RegExp(`\\b${func.name}\\s*\\(`);
            if (funcCallRegex.test(trimmed)) {
                // Contar argumentos
                const match = trimmed.match(new RegExp(`\\b${func.name}\\s*\\(([^)]*)\\)`));
                if (match) {
                    const args = match[1].split(',').filter(a => a.trim().length > 0);
                    if (args.length !== func.params) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Warning,
                            range: {
                                start: { line: index, character: trimmed.indexOf(func.name) },
                                end: { line: index, character: trimmed.indexOf(func.name) + func.name.length }
                            },
                            message: `A função ${func.name} espera ${func.params} parâmetro(s), mas recebeu ${args.length}`,
                            source: 'Por Do Sol Language Server',
                            code: 'wrong-argument-count'
                        });
                    }
                }
            }
        }

        // Sugestão de imports para classes de bibliotecas
        const usedClasses = trimmed.match(/\b[A-Z]\w+\b/g);
        if (usedClasses) {
            for (const className of usedClasses) {
                // Verificar se a classe existe em alguma biblioteca carregada
                let foundInLibrary = false;
                for (const [, library] of libraryCache) {
                    for (const [, cls] of library.classes) {
                        if (cls.name === className) {
                            foundInLibrary = true;
                            break;
                        }
                    }
                    if (foundInLibrary) break;
                }

                if (foundInLibrary) {
                    // Verificar se já tem import
                    const hasImport = text.includes(`usando ${className}`) || text.includes(`usando *`);
                    if (!hasImport) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Information,
                            range: {
                                start: { line: index, character: trimmed.indexOf(className) },
                                end: { line: index, character: trimmed.indexOf(className) + className.length }
                            },
                            message: `Considere adicionar "usando ${className};" para importar a classe`,
                            source: 'Por Do Sol Language Server',
                            code: 'missing-import'
                        });
                    }
                }
            }
        }

        // Validação de classes
        if (trimmed.includes('classe ') && !trimmed.match(/classe\s+[A-Z]\w*\s*{?/)) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: {
                    start: { line: index, character: 0 },
                    end: { line: index, character: line.length }
                },
                message: 'Nome de classe deve começar com letra maiúscula',
                source: 'Por Do Sol Language Server',
                code: 'class-naming'
            });
        }

        // Validação para detectar uso incorreto da palavra 'construtor'
        if (trimmed.includes('construtor ') && !trimmed.startsWith('//')) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: {
                    start: { line: index, character: trimmed.indexOf('construtor') },
                    end: { line: index, character: trimmed.indexOf('construtor') + 10 }
                },
                message: 'Use apenas o nome da classe para o construtor. Ex: MinhaClasse() em vez de construtor MinhaClasse()',
                source: 'Por Do Sol Language Server',
                code: 'invalid-constructor-keyword'
            });
        }

        // Validação para detectar implementação incompleta de interface
        if (trimmed.includes(': ') && trimmed.includes('interface') === false) {
            const classMatch = trimmed.match(/classe\s+(\w+)\s*:\s*(\w+)/);
            if (classMatch) {
                const className = classMatch[1];
                const interfaceName = classMatch[2];
                
                // Buscar interface em bibliotecas
                let interfaceMethods: string[] = [];
                for (const [, library] of libraryCache) {
                    for (const [fqn, cls] of library.classes) {
                        if (cls.name === interfaceName) {
                            // Assumir que métodos da interface estão em cls.methods
                            interfaceMethods = Array.from(cls.methods.keys());
                            break;
                        }
                    }
                }
                
                if (interfaceMethods.length > 0) {
                    // Verificar se os métodos estão implementados na classe
                    const classStart = index;
                    let classEnd = classStart;
                    let braceCount = 0;
                    
                    for (let i = classStart; i < lines.length; i++) {
                        if (lines[i].includes('{')) braceCount++;
                        if (lines[i].includes('}')) braceCount--;
                        if (braceCount === 0) {
                            classEnd = i;
                            break;
                        }
                    }
                    
                    const classBody = lines.slice(classStart, classEnd).join('\n');
                    const missingMethods = interfaceMethods.filter(method => !classBody.includes(method));
                    
                    if (missingMethods.length > 0) {
                        diagnostics.push({
                            severity: DiagnosticSeverity.Error,
                            range: {
                                start: { line: index, character: 0 },
                                end: { line: index, character: line.length }
                            },
                            message: `Classe ${className} não implementa métodos da interface ${interfaceName}: ${missingMethods.join(', ')}`,
                            source: 'Por Do Sol Language Server',
                            code: 'missing-interface-members'
                        });
                    }
                }
            }
        }
    });

    return diagnostics.slice(0, settings.maxNumberOfProblems);
}

// Envio de diagnósticos por push (compatibilidade)
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    const diagnostics = await computeDiagnostics(textDocument);
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Suporte ao protocolo de diagnósticos por pull
connection.onRequest('textDocument/diagnostic', async (params: any) => {
    try {
        const uri: string | undefined = params?.textDocument?.uri;
        if (!uri) return { kind: 'full', items: [] };
        const doc = documents.get(uri);
        if (!doc) return { kind: 'full', items: [] };
        const items = await computeDiagnostics(doc);
        return { kind: 'full', items };
    } catch {
        return { kind: 'full', items: [] };
    }
});

// HOVER EXPANDIDO
connection.onHover((params: HoverParams): Hover | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) {
        return null;
    }

    const position = params.position;
    const line = document.getText({
        start: { line: position.line, character: 0 },
        end: { line: position.line + 1, character: 0 }
    });

    const wordMatch = getWordAtPosition(line, position.character);
    if (!wordMatch) {
        return null;
    }

    const word = wordMatch.word;
    // Função auxiliar para buscar informações do símbolo
    function getSymbolInfo(text: string, word: string): any {
        // Exemplo simplificado: busca por variáveis, funções e classes
        const variableRegex = new RegExp(`(?:inteiro|texto|booleano|var)\\s+${word}\\b`);
        const functionRegex = new RegExp(`função\\s+${word}\\s*\\([^)]*\\)\\s*=>`);
        const classRegex = new RegExp(`classe\\s+${word}\\b`);
        if (variableRegex.test(text)) {
            return { type: 'variable', name: word, dataType: 'desconhecido', scope: 'local' };
        } else if (functionRegex.test(text)) {
            return { type: 'function', name: word, signature: `${word}()`, returnType: 'desconhecido' };
        } else if (classRegex.test(text)) {
            return { type: 'class', name: word, members: [] };
        }
        // Palavras-chave
        const keywords = ['se', 'classe', 'construtor', 'este', 'novo', 'nova', 'espaco', 'usando', 'var', 'função', 'sobrescreve', 'redefinível', 'abstrata'];
        if (keywords.includes(word)) {
            return { type: 'keyword', name: word, documentation: staticHoverInfo[word] };
        }
        return null;
    }

    // Fallback para informações estáticas de palavras-chave
    const staticHoverInfo: { [key: string]: string } = {
        'se': '**Condicional** (Por Do Sol)\n\nEstrutura de controle para decisões lógicas.\n',
        'classe': '**Orientação a Objetos** (Por Do Sol)\n\nDefinição de classe com propriedades e métodos.\n',
        'construtor': '**Método Construtor** (Por Do Sol)\n\nUse apenas o nome da classe: NomeClasse() {...}\n',
        'este': '**Referência ao Objeto** (Por Do Sol)\n\nUsado para acessar membros da instância atual.\n',
        'novo': '**Instanciação** (Por Do Sol)\n\nCriação de nova instância de classe.\n',
        'nova': '**Instanciação** (Por Do Sol)\n\nCriação de nova instância de classe (forma feminina).\n',
        'espaco': '**Namespace** (Por Do Sol)\n\nOrganização modular do código.\n',
        'var': '**Inferência de Tipo** (Por Do Sol)\n\nDeclaração com tipo inferido automaticamente.\n',
        'função': '**Declaração de Função** (Por Do Sol)\n\nDefinição de função com tipo de retorno.\n',
        'sobrescreve': '**Modificador de Sobrescrita** (Por Do Sol)\n\nIndica que um método ou propriedade sobrescreve um membro da classe base.\n',
        'redefinível': '**Modificador Redefinível** (Por Do Sol)\n\nPermite que um método ou propriedade seja sobrescrito em classes derivadas.\n'
        ,
        'decimal': '**Tipo decimal** (Por Do Sol)\n\nTipo de dados para números decimais de alta precisão, similar ao C#.\nExemplo: `decimal meuDecimal = 10.5m;`',
        'duplo': '**Tipo duplo (double)** (Por Do Sol)\n\nPonto flutuante de 64 bits. Exemplo: `duplo x = 3.0;`',
        'flutuante': '**Tipo flutuante (float)** (Por Do Sol)\n\nPonto flutuante de 32 bits. Exemplo: `flutuante y = 2.5f;`',
        'abstrata': '**Modificador Abstrato** (Por Do Sol)\n\nDefine classes e métodos sem implementação, a serem implementados por derivados. ',
        'usando': '**Importação de Namespace** (Por Do Sol)\n\nEx.: `usando Testes;`'
    };

    if (staticHoverInfo[word]) {
        const range: Range = {
            start: { line: position.line, character: wordMatch.start },
            end: { line: position.line, character: wordMatch.end }
        };

        return {
            contents: {
                kind: MarkupKind.Markdown,
                value: staticHoverInfo[word]
            },
            range: range
        };
    }

    return null;
});

// SIGNATURE HELP (parâmetros enquanto digita)
connection.onSignatureHelp((params: SignatureHelpParams): SignatureHelp | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;
    const pos = params.position;
    const text = document.getText();
    const lines = text.split('\n');
    const line = lines[pos.line] || '';

    // Encontra o nome da função/método antes do '('
    const uptoChar = line.slice(0, pos.character);
    const callMatch = /(\w+)\s*\($/.exec(uptoChar) || /(\w+)\s*\([^(]*$/.exec(uptoChar);
    if (!callMatch) return null;
    const name = callMatch[1];

    // Conta vírgulas desde o '('
    const parenIdx = uptoChar.lastIndexOf('(');
    const activeParameter = parenIdx >= 0 ? (uptoChar.slice(parenIdx + 1).match(/,/g)?.length || 0) : 0;

    // Tenta localizar declaração: função nome( ... ) ou método [mods] tipo nome( ... )
    const funcDecl = new RegExp(`^\\s*função\\s+${escapeRegex(name)}\\s*\\(([^)]*)\\)`);
    const methodDecl = new RegExp(`^\\s*(?:público|publico|privado|protegido)?\\s*(?:estática\\s+)?(?:redefinível\\s+|sobrescreve\\s+|abstrata\\s+)?(?:inteiro|texto|booleano|duplo|flutuante|decimal|vazio)\\s+${escapeRegex(name)}\\s*\\(([^)]*)\\)`);

    let paramsList: string | null = null;
    for (const l of lines) {
        let m = funcDecl.exec(l);
        if (m) { paramsList = m[1]; break; }
        m = methodDecl.exec(l);
        if (m) { paramsList = m[1]; break; }
    }
    if (paramsList === null) return null;

    const paramsArr = paramsList.split(',').map(s => s.trim()).filter(Boolean);
    const parameters: ParameterInformation[] = paramsArr.map(p => ({ label: p }));
    const label = `${name}(${paramsArr.join(', ')})`;
    const signature: SignatureInformation = {
        label,
        parameters
    };
    return {
        signatures: [signature],
        activeSignature: 0,
        activeParameter: Math.min(activeParameter, Math.max(0, parameters.length - 1))
    };
});

function findEnclosingClass(symbols: DocumentSymbol[], position: Position): DocumentSymbol | null {
    for (const s of symbols) {
        if (s.kind === SymbolKind.Class && rangeContains(s.range, position)) {
            // procurar membro mais interno ou retornar a própria classe
            if (s.children) {
                const inner = findEnclosingClass(s.children as DocumentSymbol[], position);
                return inner || s;
            }
            return s;
        }
        if (s.children && s.children.length) {
            const child = findEnclosingClass(s.children as DocumentSymbol[], position);
            if (child) return child;
        }
    }
    return null;
}

function rangeContains(range: Range, pos: Position): boolean {
    if (pos.line < range.start.line || pos.line > range.end.line) return false;
    if (pos.line === range.start.line && pos.character < range.start.character) return false;
    if (pos.line === range.end.line && pos.character > range.end.character) return false;
    return true;
}

// GO TO DEFINITION (F12) - Melhorado com cross-file navigation
interface SymbolInfo {
    name: string;
    kind: string;
    uri: string;
    line: number;
    column: number;
}

// Cache de símbolos do workspace
const workspaceSymbols: Map<string, SymbolInfo[]> = new Map();

// Função para analisar um documento e extrair símbolos
function extractSymbolsFromDocument(document: TextDocument): SymbolInfo[] {
    const text = document.getText();
    const lines = text.split('\n');
    const symbols: SymbolInfo[] = [];

    const patterns: { kind: string; regex: RegExp }[] = [
        // função nome(
        { kind: 'function', regex: /(^|\s)função\s+([a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*)\s*\(/ },
        // método: [mods] tipo nome(
        { kind: 'method', regex: /(^|\s)(público|publico|privado|protegido)?\s*(estática\s+)?(redefinível\s+|sobrescreves\s+|abstrata\s+)?(inteiro|texto|booleano|duplo|flutuante|decimal|vazio)\s+([a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*)\s*\(/ },
        // classe Nome
        { kind: 'class', regex: /(^|\s)classe\s+([a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*)(\b|\s|{)/ },
        // interface Nome
        { kind: 'interface', regex: /(^|\s)interface\s+([a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*)(\b|\s|{)/ },
        // enumeração Nome
        { kind: 'enum', regex: /(^|\s)enumeração\s+([a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*)(\b|\s|{)/ },
        // construtor
        { kind: 'constructor', regex: /(^|\s)construtor\s*\(/ },
        // variável: (tipo|var) nome (=|;|,)
        { kind: 'variable', regex: /(^|\s)(inteiro|texto|booleano|duplo|flutuante|decimal|var)\s+([a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*)(\s*[=;,)])/ }
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const p of patterns) {
            const match = p.regex.exec(line);
            if (match) {
                // Capturar o nome do símbolo (grupo 2 para maioria dos patterns)
                const name = match[2] || match[1];
                if (name) {
                    const col = line.indexOf(name);
                    if (col >= 0) {
                        symbols.push({
                            name,
                            kind: p.kind,
                            uri: document.uri,
                            line: i,
                            column: col
                        });
                    }
                }
            }
        }
    }

    return symbols;
}

// Atualizar cache de símbolos quando documento muda
documents.onDidChangeContent(change => {
    const symbols = extractSymbolsFromDocument(change.document);
    workspaceSymbols.set(change.document.uri, symbols);
});

documents.onDidOpen(e => {
    const symbols = extractSymbolsFromDocument(e.document);
    workspaceSymbols.set(e.document.uri, symbols);
});

documents.onDidClose(e => {
    workspaceSymbols.delete(e.document.uri);
});

// Carregar símbolos de todos os documentos iniciais
async function loadWorkspaceSymbols() {
    for (const doc of documents.all()) {
        const symbols = extractSymbolsFromDocument(doc);
        workspaceSymbols.set(doc.uri, symbols);
    }
}

// Chamar na inicialização
connection.onInitialized(() => {
    loadWorkspaceSymbols();
});

connection.onDefinition(async (params: DefinitionParams): Promise<Location | Location[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const pos = params.position;
    const lineText = document.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } });
    const wordInfo = getWordAtPosition(lineText, pos.character);
    if (!wordInfo) return null;
    const word = wordInfo.word;

    // Primeiro, buscar no documento atual
    const currentSymbols = workspaceSymbols.get(document.uri) || [];
    const currentMatch = currentSymbols.find(s => s.name === word);
    if (currentMatch) {
        return {
            uri: currentMatch.uri,
            range: {
                start: { line: currentMatch.line, character: currentMatch.column },
                end: { line: currentMatch.line, character: currentMatch.column + word.length }
            }
        };
    }

    // Se não encontrou no documento atual, buscar em outros documentos
    const allMatches: Location[] = [];
    for (const [uri, symbols] of workspaceSymbols) {
        if (uri === document.uri) continue; // Já verificado
        const match = symbols.find(s => s.name === word);
        if (match) {
            allMatches.push({
                uri: match.uri,
                range: {
                    start: { line: match.line, character: match.column },
                    end: { line: match.line, character: match.column + word.length }
                }
            });
        }
    }

    // Se encontrou em outros documentos, retornar todos
    if (allMatches.length > 0) {
        return allMatches;
    }

    // Buscar em bibliotecas .pbl
    for (const [path, library] of libraryCache) {
        // Buscar classes
        for (const [fqn, cls] of library.classes) {
            if (cls.name === word) {
                // Não é possível navegar para arquivo .pbl, mas podemos informar
                connection.window.showInformationMessage(`Definição encontrada na biblioteca: ${path} (${fqn})`);
                return null;
            }
            // Buscar métodos
            const method = cls.methods.get(word);
            if (method) {
                connection.window.showInformationMessage(`Definição encontrada na biblioteca: ${path} (${fqn}.${word})`);
                return null;
            }
        }
        // Buscar funções globais
        const func = library.functions.get(word);
        if (func) {
            connection.window.showInformationMessage(`Definição encontrada na biblioteca: ${path} (${word})`);
            return null;
        }
    }

    return null;
});

// FIND REFERENCES (Shift+F12)
connection.onReferences(async (params: ReferenceParams): Promise<Location[]> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const pos = params.position;
    const lineText = document.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } });
    const wordInfo = getWordAtPosition(lineText, pos.character);
    if (!wordInfo) return [];
    const word = wordInfo.word;

    const references: Location[] = [];

    // Buscar referências em todos os documentos do workspace
    for (const [uri, symbols] of workspaceSymbols) {
        const doc = documents.get(uri);
        if (!doc) continue;

        const text = doc.getText();
        const lines = text.split('\n');

        // Buscar todas as ocorrências da palavra no documento
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, 'g');
            let match;
            while ((match = regex.exec(line)) !== null) {
                // Adicionar referência
                references.push({
                    uri: uri,
                    range: {
                        start: { line: i, character: match.index },
                        end: { line: i, character: match.index + word.length }
                    }
                });
            }
        }
    }

    return references;
});

// DOCUMENT HIGHLIGHTS (Ctrl+Shift+F12 / highlight on selection)
connection.onDocumentHighlight(async (params: DocumentHighlightParams): Promise<DocumentHighlight[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const pos = params.position;
    const lineText = document.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } });
    const wordInfo = getWordAtPosition(lineText, pos.character);
    if (!wordInfo) return null;
    const word = wordInfo.word;

    const highlights: DocumentHighlight[] = [];

    // Buscar ocorrências no documento atual
    const text = document.getText();
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const regex = new RegExp(`\\b${escapeRegex(word)}\\b`, 'g');
        let match;
        while ((match = regex.exec(line)) !== null) {
            highlights.push({
                range: {
                    start: { line: i, character: match.index },
                    end: { line: i, character: match.index + word.length }
                },
                kind: DocumentHighlightKind.Read
            });
        }
    }

    return highlights;
});

// FOLDING RANGES
connection.onFoldingRanges(async (params: FoldingRangeParams): Promise<FoldingRange[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const text = document.getText();
    const lines = text.split('\n');
    const foldingRanges: FoldingRange[] = [];

    let braceStack: Array<{ line: number; type: string }> = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Detectar abertura de bloco {
        const openBrace = line.indexOf('{');
        if (openBrace >= 0) {
            braceStack.push({ line: i, type: 'brace' });
        }

        // Detectar fechamento de bloco }
        const closeBrace = line.indexOf('}');
        if (closeBrace >= 0 && braceStack.length > 0) {
            const lastOpen = braceStack.pop();
            if (lastOpen) {
                foldingRanges.push({
                    startLine: lastOpen.line,
                    endLine: i,
                    kind: FoldingRangeKind.Region
                });
            }
        }

        // Detectar comentários de bloco /* */
        const commentStart = line.indexOf('/*');
        const commentEnd = line.indexOf('*/');
        if (commentStart >= 0 && commentEnd < 0) {
            braceStack.push({ line: i, type: 'comment' });
        } else if (commentEnd >= 0 && commentStart < 0 && braceStack.length > 0) {
            const lastOpen = braceStack.pop();
            if (lastOpen && lastOpen.type === 'comment') {
                foldingRanges.push({
                    startLine: lastOpen.line,
                    endLine: i,
                    kind: FoldingRangeKind.Comment
                });
            }
        }
    }

    return foldingRanges;
});

// CODE ACTIONS (Quick Fixes)
connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[] | null> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const text = document.getText();
    const lines = text.split('\n');
    const diagnostics = params.context.diagnostics;
    const codeActions: CodeAction[] = [];

    for (const diagnostic of diagnostics) {
        const code = diagnostic.code as string;

        // Quick fix: Adicionar ponto e vírgula
        if (code === 'missing-semicolon') {
            const line = lines[diagnostic.range.start.line];
            const edit = TextDocumentEdit.create(
                { uri: document.uri, version: document.version },
                [
                    {
                        range: {
                            start: { line: diagnostic.range.start.line, character: line.length },
                            end: { line: diagnostic.range.start.line, character: line.length }
                        },
                        newText: ';'
                    }
                ]
            );

            codeActions.push({
                title: 'Adicionar ponto e vírgula (;)',
                kind: CodeActionKind.QuickFix,
                edit: { documentChanges: [edit] },
                diagnostics: [diagnostic]
            });
        }

        // Quick fix: Corrigir atributo Nativo
        if (code === 'malformed-nativo-attribute') {
            const line = lines[diagnostic.range.start.line];
            const arrobaMatch = line.match(/[Nativo]\("([^"]+)"\)/);
            
            if (arrobaMatch) {
                const namespace = arrobaMatch[1];
                const newText = `[Nativo("${namespace}")]`;
                const edit = TextDocumentEdit.create(
                    { uri: document.uri, version: document.version },
                    [
                        {
                            range: diagnostic.range,
                            newText: newText
                        }
                    ]
                );

                codeActions.push({
                    title: 'Converter para [Nativo] (sintaxe atual)',
                    kind: CodeActionKind.QuickFix,
                    edit: { documentChanges: [edit] },
                    diagnostics: [diagnostic]
                });
            }
        }

        // Quick fix: Corriger interpolação de string
        if (code === 'malformed-interpolation') {
            const line = lines[diagnostic.range.start.line];
            const match = line.match(/\$"[^"]*\{([^}]*)\}[^"]*"/);
            
            if (match) {
                const newText = `$"${match[1]}"`;
                const edit = TextDocumentEdit.create(
                    { uri: document.uri, version: document.version },
                    [
                        {
                            range: diagnostic.range,
                            newText: newText
                        }
                    ]
                );

                codeActions.push({
                    title: 'Corrigir interpolação de string',
                    kind: CodeActionKind.QuickFix,
                    edit: { documentChanges: [edit] },
                    diagnostics: [diagnostic]
                });
            }
        }

        // Quick fix: Adicionar import faltante
        if (code === 'missing-import') {
            const line = lines[diagnostic.range.start.line];
            const wordMatch = line.match(/\b([A-Z]\w+)\b/g);
            if (wordMatch) {
                for (const word of wordMatch) {
                    // Buscar em bibliotecas .pbl
                    for (const [path, library] of libraryCache) {
                        for (const [fqn, cls] of library.classes) {
                            if (cls.name === word) {
                                const namespace = fqn.split('.').slice(0, -1).join('.');
                                const importLine = `usando ${namespace};\n`;
                                
                                // Encontrar linha onde adicionar o import (após usings existentes ou no topo)
                                let insertLine = 0;
                                for (let i = 0; i < lines.length; i++) {
                                    if (lines[i].trim().startsWith('usando')) {
                                        insertLine = i + 1;
                                    } else if (lines[i].trim() && !lines[i].trim().startsWith('usando')) {
                                        break;
                                    }
                                }
                                
                                const edit = TextDocumentEdit.create(
                                    { uri: document.uri, version: document.version },
                                    [
                                        {
                                            range: {
                                                start: { line: insertLine, character: 0 },
                                                end: { line: insertLine, character: 0 }
                                            },
                                            newText: importLine
                                        }
                                    ]
                                );

                                codeActions.push({
                                    title: `Adicionar import: usando ${namespace};`,
                                    kind: CodeActionKind.QuickFix,
                                    edit: { documentChanges: [edit] },
                                    diagnostics: [diagnostic]
                                });
                            }
                        }
                    }
                }
            }
        }

        // Quick fix: Implementar métodos de interface
        if (code === 'missing-interface-members') {
            const line = lines[diagnostic.range.start.line];
            const classMatch = line.match(/classe\s+(\w+)\s*:\s*(\w+)/);
            if (classMatch) {
                const className = classMatch[1];
                const interfaceName = classMatch[2];
                
                // Buscar métodos da interface
                let interfaceMethods: string[] = [];
                for (const [, library] of libraryCache) {
                    for (const [fqn, cls] of library.classes) {
                        if (cls.name === interfaceName) {
                            interfaceMethods = Array.from(cls.methods.keys());
                            break;
                        }
                    }
                }
                
                if (interfaceMethods.length > 0) {
                    // Encontrar o final da classe (último })
                    let insertLine = lines.length - 1;
                    for (let i = diagnostic.range.start.line; i < lines.length; i++) {
                        if (lines[i].includes('}')) {
                            insertLine = i;
                            break;
                        }
                    }
                    
                    // Gerar stubs
                    const stubs = interfaceMethods.map(method => {
                        return `\n\tpúblico vazio ${method}() {\n\t\t// TODO: implementar\n\t}`;
                    }).join('\n');
                    
                    const edit = TextDocumentEdit.create(
                        { uri: document.uri, version: document.version },
                        [
                            {
                                range: {
                                    start: { line: insertLine, character: 0 },
                                    end: { line: insertLine, character: 0 }
                                },
                                newText: stubs
                            }
                        ]
                    );

                    codeActions.push({
                        title: `Implementar métodos da interface ${interfaceName}`,
                        kind: CodeActionKind.QuickFix,
                        edit: { documentChanges: [edit] },
                        diagnostics: [diagnostic]
                    });
                }
            }
        }
    }

    return codeActions;
});

// INLAY HINTS - desabilitado por incompatibilidade de versão da biblioteca
// Requer vscode-languageserver mais recente

// SEMANTIC TOKENS
connection.languages.semanticTokens.on(async (params: SemanticTokensParams): Promise<SemanticTokens> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { data: [] };

    const text = document.getText();
    const lines = text.split('\n');
    const builder = new SemanticTokensBuilder();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Detectar tipos
        const typeRegex = /\b(inteiro|texto|booleano|duplo|flutuante|decimal|objeto|vazio)\b/g;
        let match;
        while ((match = typeRegex.exec(line)) !== null) {
            builder.push(
                i,
                match.index,
                match[0].length,
                1, // type
                0  // no modifiers
            );
        }

        // Detectar palavras-chave
        const keywordRegex = /\b(função|classe|se|senão|enquanto|para|retorne|público|publico|privado|protegido|estática|assíncrono|aguarde|externo|obter|definir|nulo|verdadeiro|falso)\b/g;
        while ((match = keywordRegex.exec(line)) !== null) {
            builder.push(
                i,
                match.index,
                match[0].length,
                15, // keyword
                0
            );
        }

        // Detectar comentários
        const commentRegex = /\/\/.*$/g;
        while ((match = commentRegex.exec(line)) !== null) {
            builder.push(
                i,
                match.index,
                match[0].length,
                14, // comment
                0
            );
        }

        // Detectar strings
        const stringRegex = /"[^"]*"/g;
        while ((match = stringRegex.exec(line)) !== null) {
            builder.push(
                i,
                match.index,
                match[0].length,
                16, // string
                0
            );
        }

        // Detectar números
        const numberRegex = /\b\d+(\.\d+)?\b/g;
        while ((match = numberRegex.exec(line)) !== null) {
            builder.push(
                i,
                match.index,
                match[0].length,
                17, // number
                0
            );
        }

        // Detectar operadores
        const operatorRegex = /(\+|\-|\*|\/|%|==|!=|<=|>=|<|>|&&|\|\||!)/g;
        while ((match = operatorRegex.exec(line)) !== null) {
            builder.push(
                i,
                match.index,
                match[0].length,
                18, // operator
                0
            );
        }
    }

    return builder.build();
});

// PREPARE RENAME (para validação)
connection.onPrepareRename((params: PrepareRenameParams): Range | null => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return null;

    const pos = params.position;
    const lineText = document.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } });
    const wordInfo = getWordAtPosition(lineText, pos.character);
    if (!wordInfo) return null;

    // Verificar se a palavra pode ser renomeada (é um símbolo válido)
    const word = wordInfo.word;
    const currentSymbols = workspaceSymbols.get(document.uri) || [];
    const symbol = currentSymbols.find(s => s.name === word);
    
    if (symbol) {
        return {
            start: { line: pos.line, character: wordInfo.start },
            end: { line: pos.line, character: wordInfo.end }
        };
    }

    return null;
});

// RENAME SYMBOL (F2)
connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return { documentChanges: [] };

    const pos = params.position;
    const lineText = document.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } });
    const wordInfo = getWordAtPosition(lineText, pos.character);
    if (!wordInfo) return { documentChanges: [] };

    const oldName = wordInfo.word;
    const newName = params.newName;

    if (!newName || newName === oldName) return { documentChanges: [] };

    const documentChanges: TextDocumentEdit[] = [];

    // Buscar todas as referências usando a lógica do Find References
    for (const [uri, symbols] of workspaceSymbols) {
        const doc = documents.get(uri);
        if (!doc) continue;

        const text = doc.getText();
        const lines = text.split('\n');
        const edits: TextEdit[] = [];

        // Buscar todas as ocorrências da palavra no documento
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const regex = new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g');
            let match;
            while ((match = regex.exec(line)) !== null) {
                // Adicionar edição
                edits.push({
                    range: {
                        start: { line: i, character: match.index },
                        end: { line: i, character: match.index + oldName.length }
                    },
                    newText: newName
                });
            }
        }

        if (edits.length > 0) {
            documentChanges.push({
                textDocument: { uri: uri, version: doc.version },
                edits: edits
            });
        }
    }

    // Atualizar cache de símbolos após renomear
    setTimeout(() => {
        for (const doc of documents.all()) {
            const symbols = extractSymbolsFromDocument(doc);
            workspaceSymbols.set(doc.uri, symbols);
        }
    }, 100);

    return { documentChanges };
});

// CODE FORMATTING
connection.onDocumentFormatting(async (params: DocumentFormattingParams): Promise<TextEdit[]> => {
    const document = documents.get(params.textDocument.uri);
    if (!document) return [];

    const text = document.getText();
    const lines = text.split('\n');
    const formattedLines: string[] = [];
    let indentLevel = 0;
    const indentSize = 4; // 4 espaços por nível

    for (const line of lines) {
        const trimmed = line.trim();
        
        // Se for linha de fechamento, reduzir indentação antes
        if (trimmed.startsWith('}') || trimmed.startsWith('}') || trimmed.startsWith(']')) {
            indentLevel = Math.max(0, indentLevel - 1);
        }

        // Aplicar indentação
        const indent = ' '.repeat(indentLevel * indentSize);
        let formattedLine = indent + trimmed;

        // Regras de espaçamento em operadores
        formattedLine = formattedLine
            .replace(/\s*=\s*/g, ' = ')
            .replace(/\s*==\s*/g, ' == ')
            .replace(/\s*!=\s*/g, ' != ')
            .replace(/\s*<=\s*/g, ' <= ')
            .replace(/\s*>=\s*/g, ' >= ')
            .replace(/\s*<\s*/g, ' < ')
            .replace(/\s*>\s*/g, ' > ')
            .replace(/\s*\+\s*/g, ' + ')
            .replace(/\s*-\s*/g, ' - ')
            .replace(/\s*\*\s*/g, ' * ')
            .replace(/\s*\/\s*/g, ' / ')
            .replace(/\s*&&\s*/g, ' && ')
            .replace(/\s*\|\|\s*/g, ' || ');

        formattedLines.push(formattedLine);

        // Se for linha de abertura, aumentar indentação para próxima linha
        if (trimmed.endsWith('{') || trimmed.endsWith('[')) {
            indentLevel++;
        }
    }

    const formattedText = formattedLines.join('\n');

    return [{
        range: {
            start: { line: 0, character: 0 },
            end: { line: lines.length, character: lines[lines.length - 1].length }
        },
        newText: formattedText
    }];
});

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getWordAtPosition(line: string, character: number): { word: string; start: number; end: number } | null {
    const wordRegex = /[a-zA-ZÀ-ÿ_][a-zA-ZÀ-ÿ0-9_]*/g;
    let match;

    while ((match = wordRegex.exec(line)) !== null) {
        const start = match.index;
        const end = match.index + match[0].length;

        if (character >= start && character <= end) {
            return {
                word: match[0],
                start: start,
                end: end
            };
        }
    }

    return null;
}

// ------------------------
// DOCUMENT SYMBOLS (Outline/Breadcrumbs)
// ------------------------
connection.onDocumentSymbol((params: DocumentSymbolParams): DocumentSymbol[] => {
    try {
        const document = documents.get(params.textDocument.uri);
        if (!document) return [];
        const text = document.getText();
        return buildDocumentSymbols(text);
    } catch (error) {
        console.error('Error in documentSymbol:', error);
        return [];
    }
});

// ------------------------
// WORKSPACE SYMBOLS (Ir para símbolo)
// ------------------------
connection.onWorkspaceSymbol(async (params: WorkspaceSymbolParams): Promise<SymbolInformation[]> => {
    const query = (params.query || '').toLowerCase();
    const results: SymbolInformation[] = [];

    // 1) símbolos dos documentos abertos
    for (const doc of documents.all()) {
        const symbols = buildDocumentSymbols(doc.getText());
        results.push(...flattenToSymbolInformation(symbols, doc.uri));
    }

    // 2) varrer arquivos .pr do workspace (limitado)
    try {
        const folders = await connection.workspace.getWorkspaceFolders();
        if (folders && folders.length) {
            const uris = folders.map(f => f.uri);
            const paths = uris.filter(u => u.startsWith('file://')).map(u => uriToFsPath(u));
            const prFiles = collectPrFiles(paths, 200);
            for (const filePath of prFiles) {
                try {
                    const content = safeReadFile(filePath);
                    if (!content) continue;
                    const symbols = buildDocumentSymbols(content);
                    const fileUri = 'file://' + filePath.replace(/\\/g, '/');
                    results.push(...flattenToSymbolInformation(symbols, fileUri));
                } catch { /* ignore */ }
            }
        }
    } catch { /* ignore */ }

    if (!query) return results.slice(0, 500);
    return results.filter(s => s.name.toLowerCase().includes(query)).slice(0, 500);
});

function buildDocumentSymbols(text: string): DocumentSymbol[] {
    const lines = text.split('\n');
    const lineOffsets = computeLineOffsets(lines);
    const symbols: DocumentSymbol[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || !trimmed) continue;

        // espaco Nome { ... }
        let m = /^\s*espaco\s+([A-Z][\wÀ-ÿ_]*)\s*\{/.exec(line);
        if (m) {
            const name = m[1];
            const startChar = line.indexOf(m[0]);
            const startOffset = lineOffsets[i] + startChar;
            const endOffset = findMatchingBrace(text, startOffset + line.indexOf('{', startChar));
            const range = makeRangeFromOffsets(lineOffsets, startOffset, endOffset);
            const selRange = makeSelectionRange(line, i, name, line.indexOf(name));
            const children = parseClassLikeMembers(text, i, endOffset, lineOffsets);
            symbols.push({ name, kind: SymbolKind.Namespace, range, selectionRange: selRange, children });
            continue;
        }

        // classe Nome { ... }
        m = /^\s*(?:público|publico|privado|protegido)?\s*(?:abstrata\s+)?classe\s+([A-Z][\wÀ-ÿ_]*)[^\{]*\{/.exec(line);
        if (m) {
            const name = m[1];
            const startChar = line.indexOf(m[0]);
            const startOffset = lineOffsets[i] + startChar;
            const endOffset = findMatchingBrace(text, startOffset + line.indexOf('{', startChar));
            const range = makeRangeFromOffsets(lineOffsets, startOffset, endOffset);
            const selRange = makeSelectionRange(line, i, name, line.indexOf(name));
            const children = parseClassLikeMembers(text, i, endOffset, lineOffsets);
            symbols.push({ name, kind: SymbolKind.Class, range, selectionRange: selRange, children });
            continue;
        }

        // interface Nome { ... }
        m = /^\s*interface\s+([A-Z][\wÀ-ÿ_]*)[^\{]*\{/.exec(line);
        if (m) {
            const name = m[1];
            const startChar = line.indexOf(m[0]);
            const startOffset = lineOffsets[i] + startChar;
            const endOffset = findMatchingBrace(text, startOffset + line.indexOf('{', startChar));
            const range = makeRangeFromOffsets(lineOffsets, startOffset, endOffset);
            const selRange = makeSelectionRange(line, i, name, line.indexOf(name));
            const children = parseClassLikeMembers(text, i, endOffset, lineOffsets);
            symbols.push({ name, kind: SymbolKind.Interface, range, selectionRange: selRange, children });
            continue;
        }

        // enumeração Nome { ... }
        m = /^\s*enumeração\s+([A-Z][\wÀ-ÿ_]*)[^\{]*\{/.exec(line);
        if (m) {
            const name = m[1];
            const startChar = line.indexOf(m[0]);
            const startOffset = lineOffsets[i] + startChar;
            const endOffset = findMatchingBrace(text, startOffset + line.indexOf('{', startChar));
            const range = makeRangeFromOffsets(lineOffsets, startOffset, endOffset);
            const selRange = makeSelectionRange(line, i, name, line.indexOf(name));
            symbols.push({ name, kind: SymbolKind.Enum, range, selectionRange: selRange, children: [] });
            continue;
        }

        // função nome(...)
        m = /^\s*função\s+([A-Za-zÀ-ÿ_][\wÀ-ÿ_]*)\s*\(/.exec(line);
        if (m) {
            const name = m[1];
            const nameIdx = line.indexOf(name);
            const startOffset = lineOffsets[i] + (nameIdx >= 0 ? nameIdx : 0);
            // tentar achar corpo { ... }
            const braceIdx = line.indexOf('{');
            let range;
            if (braceIdx >= 0) {
                const endOffset = findMatchingBrace(text, lineOffsets[i] + braceIdx);
                range = makeRangeFromOffsets(lineOffsets, lineOffsets[i] + braceIdx, endOffset);
            } else {
                // sem corpo (talvez assinatura) -> linha inteira
                range = {
                    start: { line: i, character: 0 },
                    end: { line: i, character: line.length }
                };
            }
            const selRange = makeSelectionRange(line, i, name, nameIdx);
            symbols.push({ name, kind: SymbolKind.Function, range, selectionRange: selRange });
            continue;
        }

        // variável top-level: (tipo|var) nome = ... ;
        m = /^\s*(inteiro|texto|booleano|duplo|flutuante|decimal|var)\s+([A-Za-zÀ-ÿ_][\wÀ-ÿ_]*)\b/.exec(line);
        if (m) {
            const name = m[2];
            const idx = line.indexOf(name);
            const selRange = makeSelectionRange(line, i, name, idx);
            const range = { start: { line: i, character: 0 }, end: { line: i, character: line.length } };
            symbols.push({ name, kind: SymbolKind.Variable, range, selectionRange: selRange });
            continue;
        }
    }

    return symbols;
}

function parseClassLikeMembers(text: string, startLine: number, blockEndOffset: number, lineOffsets: number[]): DocumentSymbol[] {
    const symbols: DocumentSymbol[] = [];
    const startOffset = lineOffsets[startLine];
    const segment = text.slice(startOffset, blockEndOffset);
    const segLines = segment.split('\n');

    for (let j = 0; j < segLines.length; j++) {
        const line = segLines[j];
        const absLine = startLine + j;
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('//')) continue;

        // método: [mods] tipo nome(
        let m = /^\s*(?:público|publico|privado|protegido)?\s*(?:estática\s+)?(?:redefinível\s+|sobrescreve\s+|abstrata\s+)?(inteiro|texto|booleano|duplo|flutuante|decimal|vazio)\s+([A-Za-zÀ-ÿ_][\wÀ-ÿ_]*)\s*\(/.exec(line);
        if (m) {
            const name = m[2];
            const nameIdx = line.indexOf(name);
            const braceIdx = line.indexOf('{');
            let range;
            if (braceIdx >= 0) {
                const endOffset = findMatchingBrace(text, lineOffsets[absLine] + braceIdx);
                range = makeRangeFromOffsets(lineOffsets, lineOffsets[absLine] + braceIdx, endOffset);
            } else {
                range = { start: { line: absLine, character: 0 }, end: { line: absLine, character: line.length } };
            }
            const selRange = makeSelectionRange(line, absLine, name, nameIdx);
            symbols.push({ name, kind: SymbolKind.Method, range, selectionRange: selRange });
            continue;
        }

        // propriedade: [mods] tipo Nome { obter; definir; }
        m = /^\s*(?:público|publico|privado|protegido)?\s*(?:estática\s+)?(inteiro|texto|booleano|duplo|flutuante|decimal)\s+([A-Za-zÀ-ÿ_][\wÀ-ÿ_]*)\s*\{\s*(?:obter;)?\s*(?:definir;)?\s*\}/.exec(line);
        if (m) {
            const name = m[2];
            const nameIdx = line.indexOf(name);
            const selRange = makeSelectionRange(line, absLine, name, nameIdx);
            const range = { start: { line: absLine, character: 0 }, end: { line: absLine, character: line.length } };
            symbols.push({ name, kind: SymbolKind.Property, range, selectionRange: selRange });
            continue;
        }
    }
    
    // Validar todos os símbolos antes de retornar
    return symbols.map(validateDocumentSymbol);
}

function computeLineOffsets(lines: string[]): number[] {
    const offsets: number[] = [];
    let acc = 0;
    for (const l of lines) {
        offsets.push(acc);
        acc += l.length + 1; // assume \n
    }
    return offsets;
}

function makeRangeFromOffsets(lineOffsets: number[], startOffset: number, endOffset: number) {
    const start = offsetToPos(lineOffsets, startOffset);
    const end = offsetToPos(lineOffsets, Math.max(endOffset, startOffset));
    return { start, end };
}

function offsetToPos(lineOffsets: number[], offset: number): Position {
    // encontrar maior linha com offset <= dado
    let line = 0;
    for (let i = 0; i < lineOffsets.length; i++) {
        if (lineOffsets[i] <= offset) line = i; else break;
    }
    const char = offset - lineOffsets[line];
    return { line, character: char };
}

function makeSelectionRange(line: string, lineNum: number, name: string, nameIdx: number) {
    const startChar = Math.max(0, nameIdx);
    const endChar = startChar + name.length;
    // Garantir que selectionRange esteja sempre dentro de uma linha válida
    return { start: { line: lineNum, character: startChar }, end: { line: lineNum, character: endChar } };
}

// Validação para garantir que selectionRange está contido em range
function validateDocumentSymbol(symbol: DocumentSymbol): DocumentSymbol {
    const { range, selectionRange } = symbol;
    
    // Se selectionRange não estiver contido em range, ajustar
    if (selectionRange.start.line < range.start.line ||
        selectionRange.start.line > range.end.line ||
        (selectionRange.start.line === range.end.line && selectionRange.start.character > range.end.character)) {
        // Ajustar selectionRange para ser igual ao range ou para a primeira linha do range
        symbol.selectionRange = {
            start: range.start,
            end: { line: range.start.line, character: range.end.character || range.start.character + 1 }
        };
    }
    
    // Validar children recursivamente
    if (symbol.children) {
        symbol.children = symbol.children.map(validateDocumentSymbol);
    }
    
    return symbol;
}

function findMatchingBrace(text: string, openBraceOffset: number): number {
    let depth = 0;
    for (let i = openBraceOffset; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return i + 1; // posição após '}'
        }
    }
    return openBraceOffset + 1;
}

function flattenToSymbolInformation(docSymbols: DocumentSymbol[], uri: string, containerName?: string): SymbolInformation[] {
    const out: SymbolInformation[] = [];
    for (const s of docSymbols) {
        out.push({ name: s.name, kind: s.kind as unknown as SymbolKind, location: { uri, range: s.selectionRange }, containerName });
        if (s.children && s.children.length) {
            out.push(...flattenToSymbolInformation(s.children, uri, s.name));
        }
    }
    return out;
}

// Utilitários de workspace

function uriToFsPath(uri: string): string {
    // file:///C:/x/y -> C:\x\y
    const without = uri.replace('file:///', '');
    return without.replace(/\//g, path.sep);
}

function collectPrFiles(roots: string[], maxFiles: number): string[] {
    const out: string[] = [];
    for (const root of roots) {
        walk(root);
        if (out.length >= maxFiles) break;
    }
    return out.slice(0, maxFiles);

    function walk(dir: string) {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        for (const e of entries) {
            if (out.length >= maxFiles) return;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
                walk(p);
            } else if (e.isFile() && (p.endsWith('.pr') || p.endsWith('.pds'))) {
                out.push(p);
            }
        }
    }
}

function safeReadFile(p: string): string | null {
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
    validateTextDocument(change.document);
});

documents.listen(connection);
connection.listen();
