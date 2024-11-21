
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

  const fetchAllOrders = async (cursor = null, accumulatedOrders = []) => {
    const response = await admin.graphql(
      `#graphql
      query getOrdersWithTag($query: String!, $cursor: String) {
        orders(first: 250, query: $query, after: $cursor) {
          edges {
            cursor
            node {
              id
              name
              tags
              totalPrice
              createdAt
              lineItems(first: 250) {
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
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      {
        variables: {
          query: 'status:open AND fulfillment_status:unfulfilled AND tag:"combine this"',
          cursor: cursor,
        },
      }
    );

    const data = await response.json();
    if (data.errors) {
      console.error("Error fetching orders:", data.errors);
      throw new Error("Error fetching orders");
    }

    const newOrders = data.data.orders.edges.map((edge) => edge.node);
    const allOrders = [...accumulatedOrders, ...newOrders];

    if (data.data.orders.pageInfo.hasNextPage) {
      return fetchAllOrders(data.data.orders.pageInfo.endCursor, allOrders);
    }

    return allOrders;
  };

  try {
    const ordersWithTag = await fetchAllOrders();

    // Filter orders that do not end with "-C"
    const filteredOrders = ordersWithTag.filter((order) => !order.name.endsWith("-C"));

    return json({
      ordersWithTag: filteredOrders,
    });
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
  const disableAddressCheck = formData.get("disableAddressCheck") === "true";
  const ignorePreorderSeparation = formData.get("ignorePreorderSeparation") === "true"; // New line

  // Get selectedOrders from formData
  const selectedOrders = JSON.parse(formData.get("selectedOrders") || "[]");

  // Helper function to normalize address for comparison (case-insensitive) and include the customer's name
  const normalizeAddress = (address, customer) => {
    if (!address) return null;
    return {
      firstName: customer?.firstName || '', // Add customer's first name
      lastName: customer?.lastName || '',   // Add customer's last name
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
    // Fetch the order by order number and include variant IDs and shipping address
    const orderResponse = await admin.graphql(
      `#graphql
      query getOrder($query: String!) {
        orders(first: 1, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              lineItems(first: 250) {
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

    const orderData = await orderResponse.json(); // Parse the JSON data

    if (!orderData.data.orders.edges.length) {
      return json({ error: "Order not found" });
    }

    const foundOrder = orderData.data.orders.edges[0].node;
    const customerId = foundOrder.customer.id;
    const shippingAddress = foundOrder.shippingAddress; // Capture the shipping address
    const customerInfo = { firstName: foundOrder.customer.firstName, lastName: foundOrder.customer.lastName };

    // Normalize the shipping address of the found order for comparison, including the customer name
    const normalizedOriginalAddress = normalizeAddress(shippingAddress, customerInfo);

    // Extract the numeric part of the customer ID from the GID format
    const numericCustomerId = customerId.split("/").pop();

    // Fetch the latest open and unfulfilled orders for the customer
    const customerOrdersResponse = await admin.graphql(
      `#graphql
      query getCustomerOrders($query: String!) {
        orders(first: 250, sortKey: CREATED_AT, reverse: true, query: $query) {
          edges {
            node {
              id
              name
              totalPrice
              createdAt
              lineItems(first: 250) {
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

    const customerOrdersData = await customerOrdersResponse.json(); // Parse the JSON data

    let customerOrders = customerOrdersData.data.orders.edges.map((edge) => ({
      id: edge.node.id,
      orderNumber: edge.node.name,
      totalPrice: edge.node.totalPrice,
      createdAt: edge.node.createdAt,
      lineItems: edge.node.lineItems.edges.map((itemEdge) => ({
        id: itemEdge.node.id,
        name: itemEdge.node.name,
        quantity: itemEdge.node.quantity,
        variantId: itemEdge.node.variant?.id, // Use optional chaining
      })),
      shippingAddress: normalizeAddress(edge.node.shippingAddress, customerInfo), // Normalize shipping address for comparison
    }));

    // If selectedOrders is provided, filter customerOrders
    if (selectedOrders.length > 0) {
      customerOrders = customerOrders.filter(order => selectedOrders.includes(order.id));
    }

    if (combineOrders && customerOrders.length > 0) {
      if (!disableAddressCheck) {
        for (const order of customerOrders) {
          if (!addressesMatch(normalizedOriginalAddress, order.shippingAddress)) {
            throw new Error(
              `The shipping address for order ${order.orderNumber} does not match the original order's shipping address. All orders must have the same shipping address to be combined.`
            );
          }
        }
      }

      if (ignorePreorderSeparation) {
        // Combine all items into a single variantQuantityMap
        const variantQuantityMap = {};
        const freeAndEasyVariantIds = new Set();
        let orderNumberSuffix = null;

        customerOrders.forEach((order) => {
          order.lineItems.forEach((item) => {
            if (item.variantId) {
              const isFreeAndEasy = item.name.startsWith('Free and Easy Returns or Exchanges');

              if (isFreeAndEasy) {
                freeAndEasyVariantIds.add(item.variantId);
                if (!orderNumberSuffix) {
                  orderNumberSuffix = order.orderNumber + "-C";
                }
              } else {
                if (variantQuantityMap[item.variantId]) {
                  variantQuantityMap[item.variantId] += item.quantity;
                } else {
                  variantQuantityMap[item.variantId] = item.quantity;
                }
                if (!orderNumberSuffix) {
                  orderNumberSuffix = order.orderNumber + "-C";
                }
              }
            }
          });
        });

        const combinedLineItems = Object.keys(variantQuantityMap).map((variantId) => ({
          variantId,
          quantity: variantQuantityMap[variantId],
        }));

        // Include 'Free and Easy Returns or Exchanges' items with quantity 1
        freeAndEasyVariantIds.forEach((variantId) => {
          combinedLineItems.push({
            variantId,
            quantity: 1,
          });
        });

        console.log("Combined Line Items:", combinedLineItems);

        let newOrder = null; // Initialize as null

        // Create new order if there are line items
        if (combinedLineItems.length > 0) {
          const lineItems = combinedLineItems.map(item => ({
            variantId: item.variantId,
            quantity: item.quantity,
            requiresShipping: true,
            priceSet: {
              shopMoney: {
                amount: "0.00",
                currencyCode: "USD",
              }
            },
          }));

          const orderCreateResponse = await admin.graphql(
            `#graphql
            mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
              orderCreate(order: $order, options: $options) {
                order {
                  id
                  name
                  requiresShipping
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
                  name: orderNumberSuffix, // Set the name to the first original order's order number
                  lineItems,
                  customerId,
                  shippingAddress: {
                    firstName: customerInfo.firstName, // Include customer's first name
                    lastName: customerInfo.lastName,   // Include customer's last name
                    address1: shippingAddress.address1,
                    address2: shippingAddress.address2,
                    city: shippingAddress.city,
                    country: shippingAddress.country,
                    province: shippingAddress.province,
                    zip: shippingAddress.zip,
                  },
                  billingAddress: {
                    firstName: customerInfo.firstName, // Include customer's first name
                    lastName: customerInfo.lastName,   // Include customer's last name
                    address1: shippingAddress.address1,
                    address2: shippingAddress.address2,
                    city: shippingAddress.city,
                    country: shippingAddress.country,
                    province: shippingAddress.province,
                    zip: shippingAddress.zip,
                  },
                  shippingLines: [
                    {
                      title: "Standard Shipping",
                      priceSet: {
                        shopMoney: {
                          amount: "0.00", // The shipping cost as a string
                          currencyCode: "USD", // The currency code
                        },
                      },
                      code: "standard",
                      source: "Custom",
                    },
                  ],
                  financialStatus: "PAID",
                  tags: [`Combined at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`],
                },
                options: {
                  inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                  sendReceipt: true,
                },
              },
            }
          );

          const orderCreateData = await orderCreateResponse.json();

          if (orderCreateData.data.orderCreate.userErrors.length) {
            throw new Error(
              orderCreateData.data.orderCreate.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }

          newOrder = orderCreateData.data.orderCreate.order;
        } else {
          throw new Error("No items to combine");
        }

        // Cancel original orders
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
                staffnote: 'Order combined with other orders',
              },
            }
          );

          const cancelOrderData = await orderCancelResponse.json();

          if (cancelOrderData.data.orderCancel.userErrors.length) {
            throw new Error(
              cancelOrderData.data.orderCancel.userErrors
                .map((e) => e.message)
                .join(", ")
            );
          }
        }

        return json({
          success: true,
          message: "New combined order created, and original orders canceled successfully",
          completedOrder: newOrder,
        });
      } else {
      // Aggregate quantities for duplicate variants, separating 'PREORDER' items
      const variantQuantityMap = {}; // For regular items
      const preorderVariantQuantityMap = {}; // For 'PREORDER' items
      const freeAndEasyRegularVariantIds = new Set(); // For "Free and Easy Returns or Exchanges" items in regular items
      const freeAndEasyPreorderVariantIds = new Set(); // For "Free and Easy Returns or Exchanges" items in preorder items

      // Variables to store the first order numbers
      let regularOrderNumber = null;
      let preorderOrderNumber = null;

      customerOrders.forEach((order) => {
        order.lineItems.forEach((item) => {
          if (item.variantId) {
            const isPreorder = item.name.includes('PREORDER');
            const isFreeAndEasy = item.name.startsWith('Free and Easy Returns or Exchanges');

            if (isFreeAndEasy) {
              if (isPreorder) {
                freeAndEasyPreorderVariantIds.add(item.variantId);
                if (!preorderOrderNumber) {
                  preorderOrderNumber = order.orderNumber + "-C";
                }
              } else {
                freeAndEasyRegularVariantIds.add(item.variantId);
                if (!regularOrderNumber) {
                  regularOrderNumber = order.orderNumber + "-C";
                }
              }
            } else {
              const map = isPreorder ? preorderVariantQuantityMap : variantQuantityMap;
              if (map[item.variantId]) {
                map[item.variantId] += item.quantity;
              } else {
                map[item.variantId] = item.quantity;
              }
              if (isPreorder && !preorderOrderNumber) {
                preorderOrderNumber = order.orderNumber + "-C";
              } else if (!isPreorder && !regularOrderNumber) {
                regularOrderNumber = order.orderNumber + "-C";
              }
            }
          }
        });
      });

      const combinedLineItems = Object.keys(variantQuantityMap).map((variantId) => ({
        variantId,
        quantity: variantQuantityMap[variantId],
      }));

      const preorderLineItems = Object.keys(preorderVariantQuantityMap).map((variantId) => ({
        variantId,
        quantity: preorderVariantQuantityMap[variantId],
      }));

      // Include 'Free and Easy Returns or Exchanges' items with quantity 1
      if (combinedLineItems.length > 0) {
        freeAndEasyRegularVariantIds.forEach((variantId) => {
          combinedLineItems.push({
            variantId,
            quantity: 1,
          });
        });
      }
      if (preorderLineItems.length > 0) {
        freeAndEasyPreorderVariantIds.forEach((variantId) => {
          preorderLineItems.push({
            variantId,
            quantity: 1,
          });
        });
      }

      console.log("Combined Line Items:", combinedLineItems);
      console.log("Preorder Line Items:", preorderLineItems);

      let newRegularOrder = null; // Initialize as null
      let newPreorderOrder = null; // Initialize as null

      // Create new regular order if there are regular line items
      if (combinedLineItems.length > 0) {
        const lineItems = combinedLineItems.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
          requiresShipping: true,
          priceSet: {
            shopMoney: {
              amount: "0.00",
              currencyCode: "USD",
            }
          },
        }));

        const regularOrderCreateResponse = await admin.graphql(
          `#graphql
          mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
            orderCreate(order: $order, options: $options) {
              order {
                id
                name
                requiresShipping
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
                name: regularOrderNumber, // Set the name to the first original order's order number
                lineItems,
                customerId,
                shippingAddress: {
                  firstName: customerInfo.firstName, // Include customer's first name
                  lastName: customerInfo.lastName,   // Include customer's last name
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                billingAddress: {
                  firstName: customerInfo.firstName, // Include customer's first name
                  lastName: customerInfo.lastName,   // Include customer's last name
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                shippingLines: [
                  {
                    title: "Standard Shipping",
                    priceSet: {
                      shopMoney: {
                        amount: "0.00", // The shipping cost as a string
                        currencyCode: "USD", // The currency code
                      },
                    },
                    code: "standard",
                    source: "Custom",
                  },
                ],
                financialStatus: "PAID",
                tags: [`Combined at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`],
              },
              options: {
                inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                sendReceipt: true,
              },
            },
          }
        );

        const regularOrderCreateData = await regularOrderCreateResponse.json();

        if (regularOrderCreateData.data.orderCreate.userErrors.length) {
          throw new Error(
            regularOrderCreateData.data.orderCreate.userErrors
              .map((e) => e.message)
              .join(", ")
          );
        }

        newRegularOrder = regularOrderCreateData.data.orderCreate.order;
      }

      // Create new preorder order if there are preorder line items
      if (preorderLineItems.length > 0) {
        const lineItems = preorderLineItems.map(item => ({
          variantId: item.variantId,
          quantity: item.quantity,
          requiresShipping: true,
          priceSet: {
            shopMoney: {
              amount: "0.00",
              currencyCode: "USD",
            }
          },
        }));

        const preorderOrderCreateResponse = await admin.graphql(
          `#graphql
          mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
            orderCreate(order: $order, options: $options) {
              order {
                id
                name
                requiresShipping
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
                name: preorderOrderNumber, // Set the name to the second original order's order number
                lineItems,
                customerId,
                shippingAddress: {
                  firstName: customerInfo.firstName, // Include customer's first name
                  lastName: customerInfo.lastName,   // Include customer's last name
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                billingAddress: {
                  firstName: customerInfo.firstName, // Include customer's first name
                  lastName: customerInfo.lastName,   // Include customer's last name
                  address1: shippingAddress.address1,
                  address2: shippingAddress.address2,
                  city: shippingAddress.city,
                  country: shippingAddress.country,
                  province: shippingAddress.province,
                  zip: shippingAddress.zip,
                },
                shippingLines: [
                  {
                    title: "Standard Shipping",
                    priceSet: {
                      shopMoney: {
                        amount: "0.00", // The shipping cost as a string
                        currencyCode: "USD", // The currency code
                      },
                    },
                    code: "standard",
                    source: "Custom",
                  },
                ],
                financialStatus: "PAID",
                tags: [`Combined at: ${new Date().toLocaleString('en-US', { timeZone: 'America/Denver' })}`],
              },
              options: {
                inventoryBehaviour: "DECREMENT_IGNORING_POLICY",
                sendReceipt: true,
              },
            },
          }
        );

        const preorderOrderCreateData = await preorderOrderCreateResponse.json();

        if (preorderOrderCreateData.data.orderCreate.userErrors.length) {
          throw new Error(
            preorderOrderCreateData.data.orderCreate.userErrors
              .map((e) => e.message)
              .join(", ")
          );
        }

        newPreorderOrder = preorderOrderCreateData.data.orderCreate.order;
      }

      // Cancel original orders
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
              staffnote: 'Order combined with other orders',
            },
          }
        );

        const cancelOrderData = await orderCancelResponse.json();

        if (cancelOrderData.data.orderCancel.userErrors.length) {
          throw new Error(
            cancelOrderData.data.orderCancel.userErrors
              .map((e) => e.message)
              .join(", ")
          );
        }
      }

      return json({
        success: true,
        message: "New combined orders created, and original orders canceled successfully",
        completedOrder: newRegularOrder,
        preorderCompletedOrder: newPreorderOrder,
      });
      }
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
    return json({ error: error instanceof Error ? error.message : "There was an error processing the request." });
  }
};

export default function Index() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [orderNumber, setOrderNumber] = useState("");
  const [combineOrdersVisible, setCombineOrdersVisible] = useState(false);
  const [selectedOrders, setSelectedOrders] = useState([]);
  const [ordersWithTag, setOrdersWithTag] = useState(data?.ordersWithTag || []);
  const [pageCursor, setPageCursor] = useState(null);
  const [hasNextPage, setHasNextPage] = useState(data?.pageInfo?.hasNextPage);
  const [hasPreviousPage, setHasPreviousPage] = useState(data?.pageInfo?.hasPreviousPage);
  const [disableAddressCheck, setDisableAddressCheck] = useState(false);
  const [ignorePreorderSeparation, setIgnorePreorderSeparation] = useState(false); // New line
  const [isViewingOrderDetails, setIsViewingOrderDetails] = useState(false);
  const [unfulfilledOrder, setUnfulfilledOrder] = useState(null);

  const isLoading = ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";
  const error = data?.error || fetcher.data?.error;

  const handleInputChange = (value) => {
    setOrderNumber(value);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    setCombineOrdersVisible(false);
    setIsViewingOrderDetails(true);
    fetcher.submit(
      { orderNumber, disableAddressCheck: disableAddressCheck.toString() },
      { method: "POST" }
    );
  };

  const handleCombineOrders = () => {
    fetcher.submit(
      {
        orderNumber,
        combineOrders: "true",
        selectedOrders: JSON.stringify(selectedOrders),
        disableAddressCheck: disableAddressCheck.toString(),
        ignorePreorderSeparation: ignorePreorderSeparation.toString(), // New line
      },
      { method: "POST" }
    );
  };

  const handleBack = () => {
    setIsViewingOrderDetails(false);
    setOrderNumber("");
    setCombineOrdersVisible(false);
    setSelectedOrders([]);
    setDisableAddressCheck(false);
    setIgnorePreorderSeparation(false); // Reset the new state
    setUnfulfilledOrder(null);
    fetcher.load('/'); // Reload the loader data
  };

  useEffect(() => {
    if (fetcher.data && fetcher.data.unfulfilledOrder) {
      setUnfulfilledOrder(fetcher.data.unfulfilledOrder);
    } else if (!isViewingOrderDetails) {
      setUnfulfilledOrder(null);
    }

    if (fetcher.data && fetcher.data.ordersWithTag) {
      setOrdersWithTag(fetcher.data.ordersWithTag || []);
      setPageCursor(fetcher.data.pageInfo?.endCursor || null);
      setHasNextPage(fetcher.data.pageInfo?.hasNextPage || false);
      setHasPreviousPage(fetcher.data.pageInfo?.hasPreviousPage || false);
    } else if (!isViewingOrderDetails) {
      // Reset to initial data when not viewing order details
      setOrdersWithTag(data.ordersWithTag || []);
    }
  }, [fetcher.data, isViewingOrderDetails, data.ordersWithTag]);

  const customerOrders = fetcher.data?.customerOrders || [];

  useEffect(() => {
    if (error) {
      shopify.toast.show(error);
    } else if (fetcher.data && fetcher.data.success) {
      shopify.toast.show(fetcher.data.message);
    } else if (fetcher.data && !fetcher.data.unfulfilledOrder) {
      shopify.toast.show("No unfulfilled orders found.");
    }

    if (customerOrders.length > 1) {
      setCombineOrdersVisible(true);
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
              <Checkbox
                label="Disable address verification "
                checked={disableAddressCheck}
                onChange={(newChecked) => setDisableAddressCheck(newChecked)}
              />
              <Checkbox
                label="Ignore preorder "
                checked={ignorePreorderSeparation}
                onChange={(newChecked) => setIgnorePreorderSeparation(newChecked)}
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

      {isViewingOrderDetails && !isLoading && unfulfilledOrder && (
        <BlockStack gap="500">
          <Button onClick={handleBack}>Back to Order List</Button>
          <Card title={`Unfulfilled Items for Order #${unfulfilledOrder.orderNumber}`}>
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
                window.open(`shopify:/admin/orders/${orderId}`, "_blank");
              }}
            >
              View New Order #{fetcher.data.completedOrder.name}
            </Button>
          )}

          {fetcher.data.preorderCompletedOrder && (
            <Button
              primary
              onClick={() => {
                const preorderOrderId = fetcher.data.preorderCompletedOrder.id.split("/").pop();
                window.open(`shopify:/admin/orders/${preorderOrderId}`, "_blank");
              }}
            >
              View New Preorder Order #{fetcher.data.preorderCompletedOrder.name}
            </Button>
          )}
        </BlockStack>
      )}

      {!isViewingOrderDetails && ordersWithTag.length > 0 && (
        <Card title='Orders with tag "combine this"'>
          <List>
            {ordersWithTag.map((order) => (
              <List.Item key={order.id}>
                Order #{order.name} - {order.totalPrice} - Placed on:{" "}
                {new Date(order.createdAt).toLocaleDateString()}
                <Button
                  onClick={() => {
                    setIsViewingOrderDetails(true);
                    setOrderNumber(order.name);
                    fetcher.submit({ orderNumber: order.name }, { method: "POST" });
                  }}
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