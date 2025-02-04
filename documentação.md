# Documentação de Integração - Webhooks

## Visão Geral

Esta documentação descreve como integrar sua aplicação com nosso sistema de webhooks para sincronização de pedidos entre Appmax, Shopify e WooCommerce.

## Endpoint do Webhook

```
POST https://seu-dominio.com/webhook
```

## Estrutura do Payload

```json
{
  "event": "string",     // Tipo do evento
  "data": {             // Dados do pedido
    "id": number,       // ID do pedido na Appmax
    "status": "string", // Status do pedido
    "customer": {       // Dados do cliente
      "firstname": "string",
      "lastname": "string",
      "email": "string",
      "telephone": "string",
      // ... outros dados do cliente
    },
    // ... outros dados do pedido
  },
  "session_id": "string" // ID da sessão (opcional)
}
```

## Eventos Suportados

| Evento | Descrição | Status Resultante |
|--------|-----------|------------------|
| OrderApproved | Pedido aprovado | paid |
| OrderPaid | Pedido pago | paid |
| OrderPaidByPix | Pedido pago via PIX | paid |
| OrderIntegrated | Pedido integrado | paid |
| OrderRefund | Pedido reembolsado | refunded |
| PaymentNotAuthorized | Pagamento não autorizado | cancelled |
| PixExpired | PIX expirado | cancelled |
| BoletoExpired | Boleto expirado | cancelled |
| ChargebackDispute | Disputa de chargeback | under_review |
| ChargebackWon | Chargeback ganho | paid |
| OrderAuthorized | Pedido autorizado | pending |
| PixGenerated | PIX gerado | pending |
| OrderBilletCreated | Boleto criado | pending |
| OrderPixCreated | PIX criado | pending |

> **Nota**: O evento `CustomerInterested` é ignorado pelo sistema.

## Exemplos de Implementação

### PHP (usando cURL)

```php
<?php

function sendWebhook($event, $orderId, $orderData, $sessionId = null) {
    $url = 'https://seu-dominio.com/webhook';
    
    $payload = [
        'event' => $event,
        'data' => array_merge(
            ['id' => $orderId],
            $orderData
        ),
        'session_id' => $sessionId
    ];

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json'
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    return [
        'success' => $httpCode === 200,
        'response' => json_decode($response, true)
    ];
}

// Exemplo de uso
$orderData = [
    'status' => 'pending',
    'customer' => [
        'firstname' => 'João',
        'lastname' => 'Silva',
        'email' => 'joao@exemplo.com',
        'telephone' => '11999999999'
    ],
    // ... outros dados do pedido
];

$result = sendWebhook('OrderPaid', 123456, $orderData, 'session_1738252677929_abc');
```

### Node.js (usando axios)

```javascript
const axios = require('axios');

async function sendWebhook(event, orderId, orderData, sessionId = null) {
    const url = 'https://seu-dominio.com/webhook';
    
    const payload = {
        event,
        data: {
            id: orderId,
            ...orderData
        },
        session_id: sessionId
    };

    try {
        const response = await axios.post(url, payload, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        return {
            success: true,
            response: response.data
        };
    } catch (error) {
        return {
            success: false,
            error: error.response?.data || error.message
        };
    }
}

// Exemplo de uso
const orderData = {
    status: 'pending',
    customer: {
        firstname: 'João',
        lastname: 'Silva',
        email: 'joao@exemplo.com',
        telephone: '11999999999'
    }
    // ... outros dados do pedido
};

sendWebhook('OrderPaid', 123456, orderData, 'session_1738252677929_abc')
    .then(result => console.log(result))
    .catch(error => console.error(error));
```

## Exemplos de Integração com Múltiplos IDs

### PHP - Integração Completa

```php
<?php

class OrderWebhook {
    private $apiUrl;
    
    public function __construct($apiUrl) {
        $this->apiUrl = $apiUrl;
    }
    
    /**
     * Envia webhook com múltiplos IDs de diferentes plataformas
     * 
     * @param string $event Tipo do evento
     * @param array $orderIds Array com IDs das diferentes plataformas
     * @param array $orderData Dados do pedido
     * @return array Resposta do webhook
     */
    public function sendMultiPlatformWebhook($event, $orderIds, $orderData) {
        // Valida os IDs necessários
        if (empty($orderIds['appmax_id'])) {
            throw new Exception('ID da Appmax é obrigatório');
        }

        // Prepara os dados do pedido com os IDs
        $payload = [
            'event' => $event,
            'data' => array_merge(
                [
                    'id' => $orderIds['appmax_id'],  // ID principal (Appmax)
                    'woocommerce_order_id' => $orderIds['woocommerce_id'] ?? null,
                ],
                $orderData
            ),
            'session_id' => $orderIds['session_id'] ?? null
        ];

        // Configura e executa a requisição
        $ch = curl_init($this->apiUrl);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => json_encode($payload),
            CURLOPT_HTTPHEADER => [
                'Content-Type: application/json',
                'Accept: application/json'
            ]
        ]);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $error = curl_error($ch);
        curl_close($ch);

        if ($error) {
            throw new Exception("Erro na requisição: $error");
        }

        return [
            'success' => $httpCode === 200,
            'http_code' => $httpCode,
            'response' => json_decode($response, true)
        ];
    }
}

// Exemplo de uso
try {
    $webhook = new OrderWebhook('https://seu-dominio.com/webhook');

    // IDs do pedido nas diferentes plataformas
    $orderIds = [
        'appmax_id' => 123456,                    // ID do pedido na Appmax
        'woocommerce_id' => 'wc_789',             // ID do pedido no WooCommerce
        'session_id' => 'session_1738252677929_xyz' // ID da sessão
    ];

    // Dados do pedido
    $orderData = [
        'status' => 'pending',
        'customer' => [
            'firstname' => 'João',
            'lastname' => 'Silva',
            'email' => 'joao@exemplo.com',
            'telephone' => '11999999999',
            'document_number' => '123.456.789-00'
        ],
        'payment' => [
            'method' => 'credit_card',
            'installments' => 3,
            'card_brand' => 'visa'
        ],
        'bundles' => [
            [
                'products' => [
                    [
                        'name' => 'Produto Teste',
                        'quantity' => 1,
                        'price' => 99.90,
                        'sku' => 'SKU123'
                    ]
                ]
            ]
        ],
        'total' => 99.90,
        'freight_value' => 0,
        'discount' => 0
    ];

    // Envia o webhook
    $result = $webhook->sendMultiPlatformWebhook('OrderPaid', $orderIds, $orderData);

    if ($result['success']) {
        echo "Webhook enviado com sucesso!\n";
        echo "Resposta: " . print_r($result['response'], true);
    } else {
        echo "Erro ao enviar webhook. HTTP Code: " . $result['http_code'] . "\n";
        echo "Resposta: " . print_r($result['response'], true);
    }

} catch (Exception $e) {
    echo "Erro: " . $e->getMessage() . "\n";
}

// Exemplo de resposta de sucesso:
// {
//     "success": true,
//     "http_code": 200,
//     "response": {
//         "success": true,
//         "message": "Webhook processado com sucesso"
//     }
// }
```

### Notas sobre Múltiplos IDs

1. **Prioridade dos IDs**:
   - O `appmax_id` é obrigatório e usado como identificador principal
   - Os outros IDs (`woocommerce_id`, `session_id`) são opcionais
   - O sistema mantém o relacionamento entre todos os IDs no banco

2. **Rastreamento**:
   - Use o `session_id` para rastrear a origem do pedido
   - O `woocommerce_id` permite referência cruzada com o WooCommerce
   - Todos os IDs são armazenados e podem ser consultados posteriormente

3. **Consultas**:
   - Você pode buscar um pedido usando qualquer um dos IDs
   - O sistema mantém a consistência entre as diferentes referências
   - Use as consultas SQL fornecidas na seção "Consultas no Banco de Dados"

## Consultas no Banco de Dados

### Buscar Pedido por ID

```sql
-- Buscar por ID da Appmax
SELECT * FROM orders WHERE appmax_id = ?;

-- Buscar por ID da Shopify
SELECT * FROM orders WHERE shopify_id = ?;

-- Buscar por ID do WooCommerce
SELECT * FROM orders WHERE woocommerce_id = ?;

-- Buscar por ID de Sessão
SELECT * FROM orders WHERE session_id = ?;
```

### Buscar Pedidos por Data

```sql
SELECT * FROM orders 
WHERE created_at BETWEEN ? AND ?
  AND platform = ?  -- opcional
ORDER BY created_at DESC;
```

### Buscar Status de Processamento

```sql
SELECT processed_at, error 
FROM request_queue 
WHERE id = ?;
```

## Estrutura do Banco de Dados

### Tabela `orders`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | INTEGER | ID único do registro |
| appmax_id | INTEGER | ID do pedido na Appmax |
| shopify_id | TEXT | ID do pedido na Shopify |
| woocommerce_id | TEXT | ID do pedido no WooCommerce |
| session_id | TEXT | ID da sessão |
| platform | TEXT | Plataforma de origem |
| status | TEXT | Status atual do pedido |
| created_at | DATETIME | Data de criação |
| updated_at | DATETIME | Data de atualização |
| metadata | TEXT | Metadados em JSON |

### Tabela `request_queue`

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | INTEGER | ID único da requisição |
| appmax_id | INTEGER | ID do pedido na Appmax |
| event_type | TEXT | Tipo do evento |
| status | TEXT | Status do processamento |
| financial_status | TEXT | Status financeiro |
| request_data | TEXT | Dados da requisição em JSON |
| created_at | DATETIME | Data de criação |
| processed_at | DATETIME | Data de processamento |
| attempts | INTEGER | Número de tentativas |
| error | TEXT | Mensagem de erro |

## Notas Importantes

1. **Emails**: O sistema adiciona automaticamente o prefixo "email_" aos endereços de email enviados para a Shopify para evitar emails transacionais duplicados.

2. **Retry**: O sistema tenta processar cada webhook até 3 vezes em caso de falha.

3. **Validação**: Certifique-se de que todos os campos obrigatórios estejam presentes no payload.

4. **Idempotência**: O sistema é idempotente, ou seja, múltiplos webhooks com o mesmo ID serão tratados corretamente sem duplicação.

## Códigos de Erro

| Código | Descrição |
|--------|-----------|
| 400 | Dados do webhook inválidos |
| 404 | Pedido não encontrado |
| 500 | Erro interno do servidor |

## Suporte

Em caso de dúvidas ou problemas, entre em contato com nossa equipe de suporte:
- Email: suporte@exemplo.com
- Telefone: (11) 1234-5678
