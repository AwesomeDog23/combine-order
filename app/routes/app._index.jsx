import { useEffect, useState } from "react";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  List,
  TextField,
  Spinner,
  Checkbox, // Added Checkbox import
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const { admin } = await authenticate.admin(request);
  try {
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrdersWithTag($query: String!) {
        orders(first: 50, query: $query) {
          edges {
            node {
              id
              name
              tags
              totalPrice
              createdAt
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    name
                    quantity
                    variant {
                      id
                    }
                  }
                }
              }
              customer {
                id
                firstName
                lastName
                email
              }
            }
          }
        }
      }
    `,
      { variables: { query: 'status:open AND fulfillment_status:unfulfilled AND tag:"combine this"' } }
    );

    const orderData = await orderResponse.json();

    if (orderData.errors) {
      console.error("Error fetching orders:", orderData.errors);
      throw new Error("Error fetching orders");
    }

    const ordersWithTag = orderData.data.orders.edges.map((edge) => edge.node);

    return json({ ordersWithTag });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return json({ error: "Error fetching orders" });
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const orderNumber = formData.get("orderNumber");
  const combineOrders = formData.get("combineOrders") === "true";
  const selectedOrders = JSON.parse(formData.get("selectedOrders") || "[]");

  const normalizeAddress = (address, customer) => {
    if (!address) return null;
    return {
      firstName: customer?.firstName || '',
      lastName: customer?.lastName || '',
      address1: address.address1?.toLowerCase().trim(),
      address2: address.address2?.toLowerCase().trim(),
      city: address.city?.toLowerCase().trim(),
      country: address.country?.toLowerCase().trim(),
      province: address.province?.toLowerCase().trim(),
      zip: address.zip?.toLowerCase().trim(),
    };
  };

  const addressesMatch = (address1, address2) => {
    if (!address1 || !address2) return false;
    return (
      address1.firstName === address2.firstName &&
      address1.lastName === address2.lastName &&
      address1.address1 === address2.address1 &&
      address1.address2 === address2.address2 &&
      address1.city === address2.city &&
      address1.country === address2.country &&
      address1.province === address2.province &&
      address1.zip === address2.zip
    );
  };

  try {
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    name
                    quantity
                    fulfillmentStatus
                    variant {
                      id
                    }
                  }
                }
              }
              customer {
                id
                email
                firstName
                lastName
              }
              shippingAddress {
                address1
                address2
                city
                country
                zip
                province
              }
            }
          }
        }
      }
    `,
      { variables: { query: `name:${orderNumber}` } }
    );

    const orderData = await orderResponse.json();
    if (!orderData.data.orders.edges.length) {
      return json({ error: "Order not found" });
    }

    const foundOrder = orderData.data.orders.edges[0].node;
    const customerId = foundOrder.customer.id;
    const shippingAddress = foundOrder.shippingAddress;
    const customerInfo = { firstName: foundOrder.customer.firstName, lastName: foundOrder.customer.lastName };

    const normalizedOriginalAddress = normalizeAddress(shippingAddress, customerInfo);
    const numericCustomerId = customerId.split("/").pop();

    const customerOrdersResponse = await admin.graphql(
      `#graphql
      query getCustomerOrders($query: String!) {
        orders(first: 10, sortKey: CREATED_AT, reverse: true, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              createdAt
              lineItems(first: 10) {
                edges {
                  node {
                    id
                    name
                    quantity
                    variant {
                      id
                    }
                  }
                }
              }
              shippingAddress {
                address1
                address2
                city
                country
                zip
                province
              }
            }
          }
        }
      }
    `,
      { variables: { query: `status:open AND fulfillment_status:unfulfilled AND customer_id:${numericCustomerId}` } }
    );

    const customerOrdersData = await customerOrdersResponse.json();
    let customerOrders = customerOrdersData.data.orders.edges.map((edge) => ({
      id: edge.node.id,
      orderNumber: edge.node.name,
      totalPrice: edge.node.totalPrice,
      createdAt: edge.node.createdAt,
      lineItems: edge.node.lineItems.edges.map((itemEdge) => ({
        id: itemEdge.node.id,
        name: itemEdge.node.name,
        quantity: itemEdge.node.quantity,
        variantId: itemEdge.node.variant?.id,
      })),
      shippingAddress: normalizeAddress(edge.node.shippingAddress, customerInfo),
    }));

    if (selectedOrders.length > 0) {
      customerOrders = customerOrders.filter(order => selectedOrders.includes(order.id));
    }

    if (combineOrders && customerOrders.length > 0) {
      for (const order of customerOrders) {
        if (!addressesMatch(normalizedOriginalAddress, order.shippingAddress)) {
          throw new Error(
            `The shipping address for order ${order.orderNumber} does not match the original order's shipping address.`
          );
        }
      }

      const lineItems = customerOrders.flatMap(order =>
        order.lineItems.map(item => ({
          title: item.name,
          quantity: item.quantity,
          variantId: item.variantId,
        }))
      );

      const orderCreateResponse = await admin.graphql(
        `#graphql
        mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
          orderCreate(order: $order, options: $options) {
            order {
              id
              name
              totalTaxSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              lineItems(first: 5) {
                nodes {
                  variant {
                    id
                  }
                  id
                  title
                  quantity
                }
              }
            }
            userErrors {
              field
              message
            }
          }
        }
      `,
        {
          variables: {
            order: {
              lineItems,
              customer: {
                firstName: foundOrder.customer.firstName,
                lastName: foundOrder.customer.lastName,
                email: foundOrder.customer.email,
              },
              shippingAddress: {
                address1: shippingAddress.address1,
                address2: shippingAddress.address2,
                city: shippingAddress.city,
                country: shippingAddress.country,
                province: shippingAddress.province,
                zip: shippingAddress.zip,
              },
              tags: ["combined"],
            },
            options: {
              // Include options if needed, or omit this if it's not required
            },
          },
        }
      );

      const orderCreateData = await orderCreateResponse.json();

      if (orderCreateData.data.orderCreate.userErrors.length) {
        console.error("User Errors:", orderCreateData.data.orderCreate.userErrors);
        throw new Error(
          orderCreateData.data.orderCreate.userErrors
            .map((e) => e.message)
            .join(", ")
        );
      }

      const newOrder = orderCreateData.data.orderCreate.order;

      for (const order of customerOrders) {
        const orderCancelResponse = await admin.graphql(
          `#graphql
          mutation orderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!) {
            orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock) {
              job {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
          {
            variables: {
              orderId: order.id,
              reason: "OTHER",
              refund: false,
              restock: true,
            },
          }
        );

        const cancelOrderData = await orderCancelResponse.json();

        if (cancelOrderData.data.orderCancel.userErrors.length) {
          console.error("Error canceling order:", cancelOrderData.data.orderCancel.userErrors);
          throw new Error(
            cancelOrderData.data.orderCancel.userErrors
              .map((e) => e.message)
              .join(", ")
          );
        }

        console.log(`Order ${order.orderNumber} canceled successfully.`);
      }

      return json({
        success: true,
        message: "New combined order created, and original orders closed successfully",
        newOrder,
      });
    }

    return json({
      unfulfilledOrder: {
        orderNumber: foundOrder.name,
        totalPrice: foundOrder.totalPrice,
        unfulfilledItems: foundOrder.lineItems.edges
          .filter((itemEdge) => itemEdge.node.fulfillmentStatus === "UNFULFILLED")
          .map((itemEdge) => ({
            id: itemEdge.node.id,
            name: itemEdge.node.name,
            quantity: itemEdge.node.quantity,
          })),
      },
      customerOrders,
    });
  } catch (error) {
    console.error("Error fetching order or creating new order:", error);
    if (error instanceof Error) {
      return json({ error: error.message });
    } else {
      return json({ error: "There was an error processing the request." });
    }
  }
};

export default function Index() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [combineOrdersVisible, setCombineOrdersVisible] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState([]); // Added selectedOrders state
  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const ordersWithTag = data?.ordersWithTag || [];
  const error = data?.error || fetcher.data?.error;

  const handleInputChange = (value) => {
    setOrderNumber(value);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    // Reset combine orders visibility on new search
    setCombineOrdersVisible(false);
    fetcher.submit({ orderNumber }, { method: "POST" });
  };

  const handleCombineOrders = () => {
    // Trigger a new form submission to combine orders
    fetcher.submit(
      { orderNumber, combineOrders: "true", selectedOrders: JSON.stringify(selectedOrders) },
      { method: "POST" }
    );
  };

  const unfulfilledOrder = fetcher.data?.unfulfilledOrder;
  const customerOrders = fetcher.data?.customerOrders || [];

  useEffect(() => {
    if (error) {
      shopify.toast.show(error);
    } else if (fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data && !fetcher.data.unfulfilledOrder) {
      shopify.toast.show("No unfulfilled orders found.");
    }

    // If customer has multiple orders, show the combine button
    if (customerOrders.length > 1) {
      setCombineOrdersVisible(true);
      // Initialize selectedOrders with all customer order IDs
      setSelectedOrders(customerOrders.map(order => order.id));
    } else {
      setCombineOrdersVisible(false);
    }
  }, [fetcher.data, error, customerOrders, shopify]);

  const handleOrderSelectionChange = (orderId, checked) => {
    if (checked) {
      setSelectedOrders([...selectedOrders, orderId]);
    } else {
      setSelectedOrders(selectedOrders.filter(id => id !== orderId));
    }
  };

  return (
    <Page>
      <TitleBar title="Order Lookup" />

      <Layout>
        <Layout.Section>
          <Card sectioned>
            <form onSubmit={handleSubmit}>
              <TextField
                label="Order Number"
                value={orderNumber}
                onChange={handleInputChange}
                placeholder="Enter Order Number"
              />
              <Button primary submit>
                Search Orders
              </Button>
            </form>
          </Card>
        </Layout.Section>
      </Layout>

      {isLoading && <Spinner accessibilityLabel="Loading orders" size="large" />}

      {!isLoading && error && <Text color="critical">{error}</Text>}

      {!isLoading && unfulfilledOrder && (
        <BlockStack gap="500">
          <Card
            title={`Unfulfilled Items for Order #${unfulfilledOrder.orderNumber}`}
          >
            <Text>
              Order Number: {unfulfilledOrder.orderNumber} Total Price:{" "}
              {unfulfilledOrder.totalPrice}
            </Text>
            <List>
              {unfulfilledOrder.unfulfilledItems.map((item) => (
                <List.Item key={item.id}>
                  {item.name} - Quantity: {item.quantity}
                </List.Item>
              ))}
            </List>
          </Card>

          {customerOrders.length > 0 && (
            <Card title="Latest Orders for this Customer">
              <List>
                {customerOrders.map((order) => (
                  <List.Item key={order.id}>
                    <Checkbox
                      label={`Order #${order.orderNumber} - ${order.totalPrice} - Placed on: ${new Date(order.createdAt).toLocaleDateString()}`}
                      checked={selectedOrders.includes(order.id)}
                      onChange={(checked) => handleOrderSelectionChange(order.id, checked)}
                    />
                    <List>
                      {order.lineItems.map((item) => (
                        <List.Item key={item.id}>
                          {item.name} - Quantity: {item.quantity}
                        </List.Item>
                      ))}
                    </List>
                  </List.Item>
                ))}
              </List>
            </Card>
          )}
        </BlockStack>
      )}

      {combineOrdersVisible && (
        <Button fullWidth primary onClick={handleCombineOrders}>
          Combine Orders
        </Button>
      )}

      {!isLoading && fetcher.data && fetcher.data.success && (
        <BlockStack gap="500">
          <Text>{fetcher.data.message}</Text>

          {fetcher.data.completedOrder && (
            <Button
              primary
              onClick={() => {
                const orderId = fetcher.data.completedOrder.id.split("/").pop();
                window.open(`shopify:admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.completedOrder.name}
            </Button>
          )}

          {fetcher.data.preorderCompletedOrder && (
            <Button
              primary
              onClick={() => {
                const preorderOrderId = fetcher.data.preorderCompletedOrder.id
                  .split("/")
                  .pop();
                window.open(`shopify:admin/orders/${preorderOrderId}`, "_blank");
              }}
            >
              View Preorder Order #{fetcher.data.preorderCompletedOrder.name}
            </Button>
          )}
        </BlockStack>
      )}

      {!isLoading && fetcher.data && !unfulfilledOrder && !error && (
        <Text>No unfulfilled orders found.</Text>
      )}

      {ordersWithTag.length > 0 && (
        <Card title='Orders with tag "combine this"'>
          <List>
            {ordersWithTag.map((order) => (
              <List.Item key={order.id}>
                Order #{order.name} - {order.totalPrice} - Placed on:{" "}
                {new Date(order.createdAt).toLocaleDateString()}
                {/* Add button to search this order */}
                <Button
                  onClick={() =>
                    fetcher.submit(
                      { orderNumber: order.name },
                      { method: "POST" }
                    )
                  }
                >
                  View Order
                </Button>
              </List.Item>
            ))}
          </List>
        </Card>
      )}
    </Page>
  );
}