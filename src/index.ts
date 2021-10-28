import _ from 'lodash'
import URI from 'urijs'
import axios from 'axios'
import currency from 'currency.js'
import { CodecType, codecManager, CommerceCodec, CodecConfiguration, GetCategoryProductArgs, QueryContext, Operation } from '@amp-nova/aria'
import { Category, Attribute } from '@amp-nova/aria-types'

const getAttributeValue = (attributes: Attribute[] = [], name: string) => {
    return _.get(_.find(attributes, att => att.name === name), 'value')
}

class CommerceToolsCodec extends CommerceCodec {
    constructor(config: CodecConfiguration) {
        super(config)
        this.productOperation = new CommerceToolsProductOperation(config)
        this.categoryOperation = new CommerceToolsCategoryOperation(config)
    }

    async getProduct(query: QueryContext) {
        return await this.productOperation.get(query)
    }

    async getCategoryHierarchy(query: QueryContext) {
        let filter =
            query.args.id && ((c: Category) => c.id === query.args.id) ||
            query.args.slug && ((c: Category) => c.slug === query.args.slug) ||
            ((c: Category) => !c.parent?.id)

        // let categories = (await this.categoryOperation.get(query)).getResults()
        let categories = _.get(await this.categoryOperation.get(query), 'results')

        // console.log(categories)

        let populateChildren = (category: Category) => {
            category.children = _.filter(categories, (c: Category) => c.parent && c.parent.id === category.id)
            _.each(category.children, populateChildren)
            return category
        }

        return _.map(_.filter(categories, filter), populateChildren)
    }

    async getCategories(query: QueryContext) {
        return await this.getCategoryHierarchy(query)
    }

    async getCategory(query: QueryContext) {
        let x: any = _.find(await this.getCategoryHierarchy(query), (c: Category) => c.id === query.args.id || c.slug === query.args.slug)
        if (x && query.args.full) {
            x.products = await this.getProductsForCategory(x, {})
        }
        return x
    }

    async getProductsForCategory(parent: Category, args: GetCategoryProductArgs) {
        return (await this.productOperation.get(new QueryContext({
            args: {
                ...args,
                filter: `categories.id: subtree("${parent.id}")`
            }
        }))).getResults()
    }
}

// export const Codec = CommerceToolsCodec
// export const canAcceptCredentials = (creds: any) => {
//     console.log(`canAccept: ${JSON.stringify(creds)}`)
//     return true
// }

const mapImage = (image: any) => image && ({ url: image.url })

class CommerceToolsOperation extends Operation {
    accessToken?: string

    getBaseURL() {
        console.log(JSON.stringify(this.config))
        return `${this.config.credentials.api_url}/${this.config.credentials.project}/`
    }

    getRequest(context: QueryContext) {
        let uri = new URI(this.getURL(context))

        let query = {
            limit: context.args.limit,
            offset: context.args.offset,
            where: context.args.where,
            filter: context.args.filter,
            ...context.args,
        }

        // add any filters based on the args
        uri.addQuery(query)

        return uri.toString()
    }

    localize(text: any, context: QueryContext) {
        if (!text) {
            console.error(new Error().stack)
        }

        if (text.label) {
            text = text.label
        }

        if (typeof text === 'string') {
            return text
        }

        if (typeof text === 'boolean') {
            let b: Boolean = text
            return b
        }

        let localized = text[context.language] || text['en'] || text[Object.keys(text)[0]]

        // if (_.isEmpty(localized)) {
        //     console.log(`localize: ${JSON.stringify(text)}`)
        // }

        return localized
    }

    async authenticate() {
        if (!this.accessToken) {
            let response: any = await axios.post(
                `${this.config.credentials.oauth_url}/oauth/token?grant_type=client_credentials&scope=${_.first(_.split(this.config.credentials.scope, ' '))}`, {}, {
                auth: {
                    username: this.config.credentials.client_id,
                    password: this.config.credentials.client_secret
                }
            })
            this.accessToken = `${response.data.token_type} ${response.data.access_token}`
        }
        return this.accessToken
    }

    async translateResponse(data: any, mapper = ((x: any) => x)) {
        // a commercetools response will be either a single object, or an array in 'results'
        // if it is an array, limit, count, total, and offset are provided on the object

        return {
            meta: data.limit && {
                limit: data.limit,
                count: data.count,
                offset: data.offset,
                total: data.total
            },
            results: await Promise.all((data.results || data).map(await mapper))
        }
    }

    async getHeaders() {
        return { authorization: await this.authenticate() }
    }
}

// category operation
class CommerceToolsCategoryOperation extends CommerceToolsOperation {
    export(context: QueryContext) {
        let self = this
        return function (category: any) {
            return {
                id: category.id,
                parent: category.parent || {},
                ancestors: category.ancestors,
                name: self.localize(category.name, context),
                slug: self.localize(category.slug, context)
            }
        }
    }

    getRequestPath(context: QueryContext) {
        return `categories`
    }

    async get(context: QueryContext) {
        return await super.get(new QueryContext({
            ...context,
            args: {
                limit: 500,
                where:
                    context.args.slug && [`slug(${context.args.language || 'en'}="${context.args.slug}") or slug(en="${context.args.slug}")`] ||
                    context.args.id && [`id="${context.args.id}"`]
            }
        }))
    }
}
// end category operations

// cart discount operation
class CommerceToolsCartDiscountOperation extends CommerceToolsOperation {
    getRequestPath(context: QueryContext) {
        return `cart-discounts`
    }
}
// end cart discount operations

// product operation
class CommerceToolsProductOperation extends CommerceToolsOperation {
    getURL(context: QueryContext) {
        return `${this.getBaseURL()}${this.getRequestPath(context)}`
    }

    getRequestPath(context: QueryContext) {
        return (context.args.keyword || context.args.filter) ? `product-projections/search` : `product-projections`
    }

    async get(context: QueryContext) {
        if (context.args.all) {
            let getCategories = async (limit: number, offset: number) => {
                return await super.get({
                    ...context.args,
                    limit,
                    offset,
                    expand: ['categories[*]'],
                })
            }

            let results: any[] = []
            let total = -1

            while (total === -1 || results.length < total) {
                let response = await getCategories(100, results.length)
                results = results.concat(response.results)
                total = response.meta.total

                console.log(`[ ct ] retrieved products: ${results.length}/${total}`)
            }

            return {
                meta: {
                    total: results.length,
                    count: results.length
                },
                results
            }
        }
        else {
            return await super.get(new QueryContext({
                ...context,
                args: {
                    ...context.args,
                    expand: ['categories[*]'],
                    priceCountry: context.country,
                    priceCurrency: context.currency,
                    [`text.${context.language}`]: context.args.keyword,
                    filter:
                        context.args.filter ||
                        context.args.productIds && [`id:${_.map(context.args.productIds.split(','), (x: any) => `"${x}"`).join(',')}`],
                    where:
                        context.args.id && [`id="${context.args.id}"`] ||
                        context.args.slug && [`slug(${context.language}="${context.args.slug}") or slug(en="${context.args.slug}")`] ||
                        context.args.sku && [`variants(sku="${context.args.sku}")`]
                }
            }))
        }
    }

    async post(context: QueryContext) {
        context.args = {
            ...context.args,
            body: this.import(context.args.product)
        }
        return await super.post(context)
    }

    export(context: QueryContext) {
        let self = this
        return function (product: any) {
            return {
                id: product.id,
                name: self.localize(product.name, context),
                slug: self.localize(product.slug, context),
                // longDescription: product.metaDescription && self.localize(product.metaDescription, context),
                imageSetId: getAttributeValue(product.variants[0]?.attributes, 'articleNumberMax'),
                variants: _.map(_.concat(product.variants, [product.masterVariant]), (variant: any) => {
                    return {
                        sku: variant.sku || product.key,
                        prices: {
                            list: self.formatMoneyString(_.get(variant.scopedPrice || _.first(variant.prices), 'value.centAmount') / 100, context),
                            sale: self.formatMoneyString(_.get(variant.scopedPrice || _.first(variant.prices), 'value.centAmount') / 100, context)
                        },
                        images: _.map(variant.images, mapImage),
                        attributes: _.map(variant.attributes, (att: any) => ({ name: att.name, value: self.localize(att.value, context) }))
                    }
                }),
                categories: _.map(product.categories, function (cat: any) {
                    let category = cat.obj || cat
                    return {
                        id: category.id,
                        parent: category.parent,
                        ancestors: category.ancestors
                    }
                }),
                productType: product.productType.id
            }
        }
    }

    postProcessor(context: QueryContext) {
        let self = this
        return async function (products: any[]) {
            let segment = context.segment
            if (!_.isEmpty(segment) && segment !== 'null' && segment !== 'undefined') {
                let discountOperation = new CommerceToolsCartDiscountOperation(self.config)
                let cartDiscounts = (await discountOperation.get(new QueryContext())).getResults()
                let applicableDiscounts = _.filter(cartDiscounts, (cd: any) => cd.cartPredicate === `customer.customerGroup.key = "${segment.toUpperCase()}"`)

                return _.map(products, (product: any) => {
                    return {
                        ...product,
                        variants: _.map(product.variants, (variant: any) => {
                            let sale = currency(variant.prices.list).value
                            _.each(applicableDiscounts, (discount: any) => {
                                if (discount.target.type === 'lineItems') {
                                    let [predicateKey, predicateValue] = discount.target.predicate.split(" = ")
                                    if (discount.target.predicate === '1 = 1' || (predicateKey === 'productType.id' && `"${product.productType}"` === predicateValue)) {
                                        if (discount.value.type === 'relative') {
                                            // permyriad is pct off * 10000
                                            sale = sale * (1 - discount.value.permyriad / 10000)
                                        }
                                    }
                                }
                            })

                            variant.prices.sale = currency(sale).format()
                            return variant
                        })
                    }
                })
            }
            else {
                return products
            }
        }
    }
}

const type: CodecType = {
    vendor: 'commercetools',
    codecType: 'commerce',

    validate: (config: any) => {
        return config && config.credentials &&
            config.credentials.client_id &&
            config.credentials.client_secret &&
            config.credentials.oauth_url &&
            config.credentials.api_url &&
            config.credentials.project &&
            config.credentials.scope
    },

    create: (config: CodecConfiguration) => {
        return new CommerceToolsCodec(config)
    }
}
export default type

// register myself with codecManager
codecManager.registerCodecType(type)